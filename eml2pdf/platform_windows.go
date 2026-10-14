//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	contextMenuKey = `Software\Classes\SystemFileAssociations\.eml\shell\EMLzuPDF`
	runKey         = `Software\Microsoft\Windows\CurrentVersion\Run`
	uninstallKey   = `Software\Microsoft\Windows\CurrentVersion\Uninstall\EMLzuPDF`
)

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// ---------------------------------------------------------------- Meldungen

func messageBox(title, text string, flags uint32) int32 {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(title)
	r, _ := windows.MessageBox(0, t, c, flags|windows.MB_SETFOREGROUND|windows.MB_TOPMOST)
	return r
}

func showInfo(title, text string)    { messageBox(title, text, windows.MB_OK|windows.MB_ICONINFORMATION) }
func showWarning(title, text string) { messageBox(title, text, windows.MB_OK|windows.MB_ICONWARNING) }
func askYesNo(title, text string) bool {
	return messageBox(title, text, windows.MB_YESNO|windows.MB_ICONQUESTION) == 6 // IDYES
}

// ---------------------------------------------------------------- Sperren

func acquireWorkerLock() func() {
	name, _ := windows.UTF16PtrFromString(`Local\EMLzuPDF-Umwandlung`)
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil && h == 0 {
		return func() {}
	}
	windows.WaitForSingleObject(h, windows.INFINITE)
	return func() {
		windows.ReleaseMutex(h)
		windows.CloseHandle(h)
	}
}

func tryWatcherLock() bool {
	name, _ := windows.UTF16PtrFromString(`Local\EMLzuPDF-Ueberwachung`)
	_, err := windows.CreateMutex(nil, true, name)
	return err != windows.ERROR_ALREADY_EXISTS
}

// ---------------------------------------------------------------- Ordner

func downloadsFolder() string {
	if p, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads")
}

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", appName)
}

func installedExe() string { return filepath.Join(installDir(), exeName) }

func isInstalledCopy() bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(self), filepath.Clean(installedExe()))
}

// ---------------------------------------------------------------- Installation

func stopOtherInstances() {
	cmd := exec.Command("taskkill", "/F", "/IM", exeName, "/FI", "PID ne "+strconv.Itoa(os.Getpid()))
	hideWindow(cmd)
	cmd.Run()
}

func setString(root registry.Key, path, name, value string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func notifyShell() {
	// SHChangeNotify(SHCNE_ASSOCCHANGED) – Explorer lädt das Kontextmenü neu
	shell32 := windows.NewLazySystemDLL("shell32.dll")
	shell32.NewProc("SHChangeNotify").Call(0x08000000, 0, 0, 0)
}

func installApp() {
	if !askYesNo(appName+" installieren", appName+" "+version+" jetzt installieren?\n\n"+
		"Danach: .eml-Dateien markieren → Rechtsklick → „In PDF umwandeln“.\n"+
		"Es entsteht ein PDF der E-Mail und je eines pro Anlage – im selben Ordner.") {
		return
	}
	self, err := os.Executable()
	if err != nil {
		showWarning(appName, "Installation fehlgeschlagen: "+err.Error())
		return
	}
	stopOtherInstances()
	exe := installedExe()
	if !strings.EqualFold(filepath.Clean(self), filepath.Clean(exe)) {
		os.MkdirAll(installDir(), 0o755)
		if err := copyFile(self, exe); err != nil {
			showWarning(appName, "Installation fehlgeschlagen:\n"+err.Error())
			return
		}
	}

	q := func(s string) string { return `"` + s + `"` }
	steps := []error{
		setString(registry.CURRENT_USER, contextMenuKey, "MUIVerb", "In PDF umwandeln"),
		setString(registry.CURRENT_USER, contextMenuKey, "Icon", q(exe)+",0"),
		setString(registry.CURRENT_USER, contextMenuKey, "MultiSelectModel", "Player"),
		setString(registry.CURRENT_USER, contextMenuKey+`\command`, "", q(exe)+` "%1"`),

		setString(registry.CURRENT_USER, uninstallKey, "DisplayName", appName),
		setString(registry.CURRENT_USER, uninstallKey, "DisplayVersion", version),
		setString(registry.CURRENT_USER, uninstallKey, "Publisher", "ergoforyou"),
		setString(registry.CURRENT_USER, uninstallKey, "DisplayIcon", q(exe)),
		setString(registry.CURRENT_USER, uninstallKey, "InstallLocation", installDir()),
		setString(registry.CURRENT_USER, uninstallKey, "UninstallString", q(exe)+" --deinstallieren"),
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE); err == nil {
		k.SetDWordValue("NoModify", 1)
		k.SetDWordValue("NoRepair", 1)
		k.Close()
	}
	for _, err := range steps {
		if err != nil {
			showWarning(appName, "Installation fehlgeschlagen:\n"+err.Error())
			return
		}
	}

	auto := askYesNo(appName, "Soll zusätzlich der Downloads-Ordner automatisch überwacht werden?\n\n"+
		"Dann wird jede neu heruntergeladene .eml ohne Klick sofort umgewandelt.\n"+
		"(Läuft unsichtbar im Hintergrund ab der Windows-Anmeldung.)")
	if auto {
		setString(registry.CURRENT_USER, runKey, appName, q(exe)+" --ueberwachen")
		cmd := exec.Command(exe, "--ueberwachen")
		hideWindow(cmd)
		cmd.Start()
	} else if k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE); err == nil {
		k.DeleteValue(appName)
		k.Close()
	}
	notifyShell()

	text := "Fertig installiert!\n\n" +
		"• .eml-Dateien markieren → Rechtsklick → „In PDF umwandeln“\n" +
		"   (Windows 11: zuerst „Weitere Optionen anzeigen“ oder Umschalt + Rechtsklick)\n"
	if auto {
		text += "• Neue .eml im Downloads-Ordner werden automatisch umgewandelt\n"
	}
	text += "\nDeinstallieren: Einstellungen → Apps → „" + appName + "“."
	if findBrowser() == "" {
		text += "\n\nACHTUNG: Microsoft Edge wurde nicht gefunden – er wird für die PDFs benötigt."
	}
	showInfo(appName, text)
}

func uninstallApp() {
	if !askYesNo(appName, appName+" wirklich deinstallieren?\n\nBereits erstellte PDFs bleiben erhalten.") {
		return
	}
	stopOtherInstances()
	registry.DeleteKey(registry.CURRENT_USER, contextMenuKey+`\command`)
	registry.DeleteKey(registry.CURRENT_USER, contextMenuKey)
	registry.DeleteKey(registry.CURRENT_USER, uninstallKey)
	if k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE); err == nil {
		k.DeleteValue(appName)
		k.Close()
	}
	notifyShell()
	showInfo(appName, appName+" wurde entfernt.")

	// Laufende .exe kann sich nicht selbst löschen -> kurz danach per cmd entfernen
	script := fmt.Sprintf(`ping -n 3 127.0.0.1 >nul & rmdir /s /q "%s" & rmdir /s /q "%s"`, installDir(), dataDir)
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
		CmdLine:       `cmd.exe /c ` + script,
	}
	cmd.Start()
}
