//go:build darwin

package main

import (
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// macOS: Programm-Paket "EML zu PDF.app" in ~/Programme, Rechtsklick über eine
// Finder-Schnellaktion, Automatik über einen LaunchAgent. Keine Admin-Rechte nötig.

const (
	bundleName     = appName + ".app"
	bundleExe      = "eml2pdf"
	agentLabel     = "de.ergoforyou.eml-zu-pdf"
	quickAction    = "In PDF umwandeln.workflow"
	libreOfficeURL = "https://de.libreoffice.org/download/download/"
)

func home() string {
	h, _ := os.UserHomeDir()
	return h
}

func downloadsFolder() string { return filepath.Join(home(), "Downloads") }

func installedBundle() string { return filepath.Join(home(), "Applications", bundleName) }
func installedExe() string    { return filepath.Join(installedBundle(), "Contents", "MacOS", bundleExe) }
func quickActionPath() string { return filepath.Join(home(), "Library", "Services", quickAction) }
func launchAgentPath() string {
	return filepath.Join(home(), "Library", "LaunchAgents", agentLabel+".plist")
}

// ownBundle liefert den Pfad des .app-Pakets, aus dem das Programm gerade läuft.
func ownBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	b := filepath.Dir(filepath.Dir(filepath.Dir(exe))) // .../X.app/Contents/MacOS/eml2pdf
	if strings.HasSuffix(b, ".app") {
		return b
	}
	return ""
}

func isInstalledCopy() bool {
	own := ownBundle()
	if own == "" {
		return true // nackte Programmdatei (Kommandozeile): nichts installieren
	}
	want, err := filepath.EvalSymlinks(installedBundle())
	return err == nil && own == want
}

// ---------------------------------------------------------------- Dialoge (über AppleScript)

func appleScriptString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func dialogIcon(warning bool) string {
	if warning {
		return "caution"
	}
	if b := ownBundle(); b != "" {
		if icns := filepath.Join(b, "Contents", "Resources", "AppIcon.icns"); fileExists(icns) {
			return "(POSIX file " + appleScriptString(icns) + ")"
		}
	}
	return "note"
}

// osascript führt ein AppleScript aus; Texte werden als Argumente übergeben (kein Escaping-Ärger).
func osascript(script string, args ...string) (string, error) {
	cmd := exec.Command("osascript", append([]string{"-e", "on run argv", "-e", script, "-e", "end run"}, args...)...)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// dialog zeigt eine Meldung mit Knöpfen und liefert den gedrückten Knopf.
func dialog(title, text string, warning bool, buttons ...string) string {
	quoted := make([]string, len(buttons))
	for i, b := range buttons {
		quoted[i] = appleScriptString(b)
	}
	script := "activate\n" +
		"set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {" + strings.Join(quoted, ", ") + "}" +
		" default button " + appleScriptString(buttons[len(buttons)-1]) + " with icon " + dialogIcon(warning) + "\n" +
		"return button returned of r"
	out, err := osascript(script, text, title)
	if err != nil {
		fmt.Printf("[%s]\n%s\n", title, text) // z. B. ohne Bildschirm: wenigstens ausgeben
		return ""
	}
	return out
}

func showInfo(title, text string) { dialog(title, text, false, "OK") }

// showResult: Abschlussmeldung mit Knopf, der den Zielordner im Finder öffnet.
func showResult(title, text, folder string, warning bool) {
	if folder == "" {
		dialog(title, text, warning, "OK")
		return
	}
	if dialog(title, text, warning, "Ordner öffnen", "OK") == "Ordner öffnen" {
		exec.Command("open", folder).Run()
	}
}
func showWarning(title, text string) { dialog(title, text, true, "OK") }
func askYesNo(title, text string) bool {
	return dialog(title, text, false, "Nein", "Ja") == "Ja"
}

func chooseFolder(prompt, start string) (string, bool) {
	out, err := osascript("activate\n"+
		"set f to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))\n"+
		"return POSIX path of f", prompt, start)
	if err != nil || out == "" {
		return "", false // abgebrochen
	}
	return strings.TrimSuffix(out, "/"), true
}

// ---------------------------------------------------------------- Installation

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		switch {
		case info.IsDir():
			return os.MkdirAll(target, 0o755)
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
	})
}

func launchctl(args ...string) error {
	return exec.Command("launchctl", args...).Run()
}

func stopWatcher() {
	uid := strconv.Itoa(os.Getuid())
	if launchctl("bootout", "gui/"+uid+"/"+agentLabel) != nil {
		launchctl("unload", launchAgentPath())
	}
}

func startWatcher(exe string) error {
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + agentLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + html.EscapeString(exe) + `</string>
		<string>--ueberwachen</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`
	os.MkdirAll(filepath.Dir(launchAgentPath()), 0o755)
	if err := os.WriteFile(launchAgentPath(), []byte(plist), 0o644); err != nil {
		return err
	}
	uid := strconv.Itoa(os.Getuid())
	if err := launchctl("bootstrap", "gui/"+uid, launchAgentPath()); err != nil {
		return launchctl("load", "-w", launchAgentPath())
	}
	return nil
}

// writeQuickAction legt die Finder-Schnellaktion "In PDF umwandeln" an
// (Automator-Arbeitsablauf mit "Shell-Skript ausführen", Dateien als Argumente).
func writeQuickAction(exe string) error {
	dir := quickActionPath()
	os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Join(dir, "Contents"), 0o755); err != nil {
		return err
	}
	command := `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", `\$`, "`", "\\`").Replace(exe) + `" "$@"`
	info := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key>
			<string>background</string>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>In PDF umwandeln</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>com.apple.mail.email</string>
				<string>public.email-message</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`
	wflow := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>` + html.EscapeString(command) + `</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>4A5C3C55-6B7E-4F2B-9E2B-1D1C0E6C1A01</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
				</array>
				<key>OutputUUID</key>
				<string>4A5C3C55-6B7E-4F2B-9E2B-1D1C0E6C1A02</string>
				<key>UUID</key>
				<string>4A5C3C55-6B7E-4F2B-9E2B-1D1C0E6C1A03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:305.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<false/>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`
	if err := os.WriteFile(filepath.Join(dir, "Contents", "Info.plist"), []byte(info), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "Contents", "document.wflow"), []byte(wflow), 0o644); err != nil {
		return err
	}
	// Dienste-Menü neu einlesen, damit die Schnellaktion sofort erscheint
	exec.Command("/System/Library/CoreServices/pbs", "-flush").Run()
	exec.Command("/System/Library/CoreServices/pbs", "-update").Run()
	return nil
}

func installApp() {
	if !askYesNo(appName+" installieren", appName+" "+version+" jetzt installieren?\n\n"+
		"Danach: .eml-Dateien im Finder markieren → Rechtsklick → Schnellaktionen → „In PDF umwandeln“.\n\n"+
		"Pro E-Mail entsteht eine PDF-Datei – die Anlagen werden hinten angehängt.") {
		return
	}
	src := ownBundle()
	if src == "" {
		showWarning(appName, "Installation nur aus dem Programm-Paket „"+bundleName+"“ möglich.")
		return
	}
	stopWatcher()
	dst := installedBundle()
	os.MkdirAll(filepath.Dir(dst), 0o755)
	tmp := dst + ".neu"
	os.RemoveAll(tmp)
	if err := copyTree(src, tmp); err != nil {
		showWarning(appName, "Installation fehlgeschlagen:\n"+err.Error())
		return
	}
	os.RemoveAll(dst)
	if err := os.Rename(tmp, dst); err != nil {
		showWarning(appName, "Installation fehlgeschlagen:\n"+err.Error())
		return
	}
	exe := installedExe()
	if err := writeQuickAction(exe); err != nil {
		showWarning(appName, "Die Schnellaktion konnte nicht angelegt werden:\n"+err.Error())
		return
	}

	dir, ok := askOutputFolder()
	if !ok {
		dir = "(neben der jeweiligen .eml-Datei)"
	}

	auto := askYesNo(appName, "Soll zusätzlich der Downloads-Ordner automatisch überwacht werden?\n\n"+
		"Dann wird jede neu heruntergeladene .eml ohne Klick sofort umgewandelt.\n"+
		"(Läuft unsichtbar im Hintergrund ab der Anmeldung.)")
	if auto {
		showInfo(appName, "macOS fragt gleich, ob „"+appName+"“ auf den Ordner „Downloads“ zugreifen darf.\n\n"+
			"Bitte mit „Erlauben“ bzw. „OK“ bestätigen – sonst kann die Automatik keine neuen Mails sehen.")
		os.ReadDir(downloadsFolder()) // löst die Rückfrage jetzt aus (nicht später unbemerkt im Hintergrund)
		if err := startWatcher(exe); err != nil {
			showWarning(appName, "Die Automatik konnte nicht gestartet werden:\n"+err.Error())
			auto = false
		}
	} else {
		os.Remove(launchAgentPath())
	}

	text := "Fertig installiert!\n\n" +
		"• .eml-Dateien im Finder markieren → Rechtsklick → Schnellaktionen → „In PDF umwandeln“\n" +
		"   (falls der Eintrag fehlt: Systemeinstellungen → Allgemein → Anmeldeobjekte & Erweiterungen → Finder → „In PDF umwandeln“ aktivieren)\n" +
		"• Ergebnis: eine PDF-Datei pro E-Mail, die Anlagen hinten angehängt\n" +
		"• Gespeichert in: " + dir + "\n"
	if auto {
		text += "• Neue .eml im Downloads-Ordner werden automatisch umgewandelt\n"
	}
	text += "\nZielordner ändern oder deinstallieren: „" + appName + "“ in Programme (Ordner „Programme“ im Benutzerordner) öffnen."
	if !libreOfficeInstalled() {
		text += "\n\nHinweis: LibreOffice ist nicht installiert. Word-/Excel-/PowerPoint-Anlagen werden dann " +
			"nicht angehängt, sondern separat abgelegt. LibreOffice ist kostenlos: " + libreOfficeURL
	}
	showInfo(appName, text)
}

func libreOfficeInstalled() bool {
	if _, err := exec.LookPath("soffice"); err == nil {
		return true
	}
	for _, base := range []string{"/Applications", filepath.Join(home(), "Applications")} {
		if fileExists(filepath.Join(base, "LibreOffice.app/Contents/MacOS/soffice")) {
			return true
		}
	}
	return false
}

func uninstallApp() {
	if !askYesNo(appName, appName+" wirklich deinstallieren?\n\nBereits erstellte PDFs bleiben erhalten.") {
		return
	}
	stopWatcher()
	os.Remove(launchAgentPath())
	os.RemoveAll(quickActionPath())
	exec.Command("/System/Library/CoreServices/pbs", "-update").Run()
	os.RemoveAll(installedBundle())
	os.RemoveAll(dataDir)
	showInfo(appName, appName+" wurde entfernt.")
}

// mainMenu erscheint, wenn das installierte Programm ohne Dateien geöffnet wird.
func mainMenu(outDir string) {
	target := outDir
	if target == "" {
		target = "(neben der jeweiligen .eml-Datei)"
	}
	switch dialog(appName+" "+version, "So geht's:\n\n.eml-Dateien im Finder markieren → Rechtsklick → "+
		"Schnellaktionen → „In PDF umwandeln“.\n\nDie PDFs werden gespeichert in:\n"+target, false,
		"Deinstallieren", "Zielordner ändern", "OK") {
	case "Zielordner ändern":
		if dir, ok := askOutputFolder(); ok {
			showInfo(appName, "Die PDFs werden ab jetzt hier gespeichert:\n\n"+dir)
		}
	case "Deinstallieren":
		uninstallApp()
	}
}
