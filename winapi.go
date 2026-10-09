//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	mpr      = windows.NewLazySystemDLL("mpr.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")

	procSHParseDisplayName       = shell32.NewProc("SHParseDisplayName")
	procSHCreateDataObject       = shell32.NewProc("SHCreateDataObject")
	procSHDoDragDrop             = shell32.NewProc("SHDoDragDrop")
	procSHFileOperationW         = shell32.NewProc("SHFileOperationW")
	procCoTaskMemFree            = ole32.NewProc("CoTaskMemFree")
	procOpenClipboard            = user32.NewProc("OpenClipboard")
	procCloseClipboard           = user32.NewProc("CloseClipboard")
	procEmptyClipboard           = user32.NewProc("EmptyClipboard")
	procSetClipboardData         = user32.NewProc("SetClipboardData")
	procRegisterClipboardFormatW = user32.NewProc("RegisterClipboardFormatW")
	procRegisterHotKey           = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey         = user32.NewProc("UnregisterHotKey")
	procGetMessageW              = user32.NewProc("GetMessageW")
	procPostThreadMessageW       = user32.NewProc("PostThreadMessageW")
	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
	procGlobalAlloc              = kernel32.NewProc("GlobalAlloc")
	procGlobalLock               = kernel32.NewProc("GlobalLock")
	procGlobalUnlock             = kernel32.NewProc("GlobalUnlock")
	procGlobalFree               = kernel32.NewProc("GlobalFree")
	procWNetAddConnection3W      = mpr.NewProc("WNetAddConnection3W")
	procWNetGetConnectionW       = mpr.NewProc("WNetGetConnectionW")
	procAddFontMemResourceEx     = gdi32.NewProc("AddFontMemResourceEx")
)

// ---------- Dateien als Shell-Objekt (für Drag & Drop) ----------

var iidIDataObject = windows.GUID{Data1: 0x0000010e, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}

// DragFiles startet Drag & Drop der Dateien – Ziel kann Explorer, Outlook,
// ein Browser (Google Drive, Claude …) oder jedes andere Programm sein.
func DragFiles(hwnd uintptr, paths []string) error {
	var pidls []uintptr
	defer func() {
		for _, p := range pidls {
			procCoTaskMemFree.Call(p)
		}
	}()
	for _, p := range paths {
		var pidl uintptr
		hr, _, _ := procSHParseDisplayName.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(p))), 0,
			uintptr(unsafe.Pointer(&pidl)), 0, 0)
		if hr == 0 && pidl != 0 {
			pidls = append(pidls, pidl)
		}
	}
	if len(pidls) == 0 {
		return errors.New("keine der Dateien ist erreichbar")
	}
	desktop := [2]byte{} // leere ID-Liste = Desktop als gemeinsamer Ursprung
	var obj uintptr
	hr, _, _ := procSHCreateDataObject.Call(uintptr(unsafe.Pointer(&desktop[0])), uintptr(len(pidls)),
		uintptr(unsafe.Pointer(&pidls[0])), 0, uintptr(unsafe.Pointer(&iidIDataObject)), uintptr(unsafe.Pointer(&obj)))
	if hr != 0 || obj == 0 {
		return dragFilesSimple(paths) // z. B. ältere Systeme: eigenes Datenobjekt
	}
	defer comRelease(obj)
	const dropEffectCopy, dropEffectLink = 1, 4
	var effect uint32
	procSHDoDragDrop.Call(hwnd, obj, 0, dropEffectCopy|dropEffectLink, uintptr(unsafe.Pointer(&effect)))
	return nil
}

func comRelease(obj uintptr) {
	vtbl := *(*[3]uintptr)(unsafe.Pointer(*(*uintptr)(unsafe.Pointer(obj))))
	syscall.SyscallN(vtbl[2], obj)
}

// ---------- Zwischenablage: Dateien (wie Strg+C im Explorer) ----------

func CopyFilesToClipboard(hwnd uintptr, paths []string) error {
	hDrop := makeHDrop(paths)
	if hDrop == 0 {
		return errors.New("GlobalAlloc fehlgeschlagen")
	}
	const gmemMoveable, gmemZeroInit = 0x0002, 0x0040
	hEff, _, _ := procGlobalAlloc.Call(gmemMoveable|gmemZeroInit, 4)
	if hEff != 0 {
		p, _, _ := procGlobalLock.Call(hEff)
		*(*uint32)(unsafe.Pointer(p)) = 1 // DROPEFFECT_COPY
		procGlobalUnlock.Call(hEff)
	}

	if r, _, _ := procOpenClipboard.Call(hwnd); r == 0 {
		procGlobalFree.Call(hDrop)
		if hEff != 0 {
			procGlobalFree.Call(hEff)
		}
		return errors.New("Zwischenablage ist gerade belegt")
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	if r, _, _ := procSetClipboardData.Call(cfHDROP, hDrop); r == 0 {
		procGlobalFree.Call(hDrop)
	}
	if hEff != 0 {
		fmtEff, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Preferred DropEffect"))))
		if r, _, _ := procSetClipboardData.Call(fmtEff, hEff); r == 0 {
			procGlobalFree.Call(hEff)
		}
	}
	return nil
}

// ---------- Kopieren mit dem Windows-eigenen Fortschrittsdialog ----------

type shFileOpStruct struct {
	Hwnd                 uintptr
	Func                 uint32
	From                 *uint16
	To                   *uint16
	Flags                uint16
	AnyOperationsAborted int32
	NameMappings         uintptr
	ProgressTitle        *uint16
}

func doubleNull(list []string) *uint16 {
	var buf []uint16
	for _, s := range list {
		buf = append(buf, windows.StringToUTF16(s)...)
	}
	buf = append(buf, 0)
	return &buf[0]
}

// CopyFilesTo kopiert Dateien/Ordner in den Zielordner (blockiert bis fertig).
func CopyFilesTo(paths []string, target string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	defer windows.CoUninitialize()
	const foCopy = 2
	const fofAllowUndo, fofNoConfirmMkdir = 0x40, 0x200
	op := shFileOpStruct{Func: foCopy, From: doubleNull(paths), To: doubleNull([]string{target}),
		Flags: fofAllowUndo | fofNoConfirmMkdir}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 && op.AnyOperationsAborted == 0 {
		return fmt.Errorf("Kopieren fehlgeschlagen (Code %d)", r)
	}
	return nil
}

// ---------- Netzlaufwerke ----------

type netResource struct {
	Scope, Type, DisplayType, Usage uint32
	LocalName, RemoteName           *uint16
	Comment, Provider               *uint16
}

// ShareRoot liefert \\server\freigabe zu einem UNC-Pfad, sonst "".
func ShareRoot(p string) string {
	if !strings.HasPrefix(p, `\\`) {
		return ""
	}
	parts := strings.SplitN(strings.TrimPrefix(p, `\\`), `\`, 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	return `\\` + parts[0] + `\` + parts[1]
}

// CurrentConnection liefert, womit ein Laufwerksbuchstabe verbunden ist ("" = frei).
func CurrentConnection(letter string) string {
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	r, _, _ := procWNetGetConnectionW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(letter))),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r != 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}

// ConnectShare verbindet eine Freigabe (optional mit Laufwerksbuchstabe). Wenn Zugangsdaten
// fehlen, fragt Windows selbst nach und bietet „Anmeldedaten speichern“ an.
func ConnectShare(hwnd uintptr, letter, remote string) error {
	remote = strings.TrimRight(strings.TrimSpace(remote), `\`)
	if letter != "" {
		letter = strings.ToUpper(letter[:1]) + ":"
		if cur := CurrentConnection(letter); cur != "" {
			if strings.EqualFold(strings.TrimRight(cur, `\`), remote) {
				return nil
			}
			return fmt.Errorf("%s ist bereits mit %s verbunden", letter, cur)
		}
		if _, err := os.Stat(letter + `\`); err == nil {
			return fmt.Errorf("%s ist bereits belegt", letter)
		}
	} else if _, err := os.Stat(remote); err == nil {
		return nil // schon erreichbar
	}
	nr := netResource{Type: 1 /* RESOURCETYPE_DISK */, RemoteName: windows.StringToUTF16Ptr(remote)}
	if letter != "" {
		nr.LocalName = windows.StringToUTF16Ptr(letter)
	}
	const connectInteractive = 0x8
	r, _, _ := procWNetAddConnection3W.Call(hwnd, uintptr(unsafe.Pointer(&nr)), 0, 0, connectInteractive)
	switch r {
	case 0, 1219: // 1219 = bereits mit anderen Anmeldedaten verbunden → funktioniert trotzdem
		return nil
	case 1223:
		return errors.New("Anmeldung abgebrochen")
	default:
		return fmt.Errorf("%s: %v", remote, syscall.Errno(r))
	}
}

// ---------- Globale Tastenkombination ----------

type hotkeyDef struct {
	mods, vk uint32
}

var hotkeys = map[string]hotkeyDef{
	"Strg+Alt+Leertaste":      {0x2 | 0x1, 0x20},
	"Strg+Umschalt+Leertaste": {0x2 | 0x4, 0x20},
	"Strg+Alt+F":              {0x2 | 0x1, 'F'},
	"Strg+Alt+S":              {0x2 | 0x1, 'S'},
	"Win+Umschalt+F":          {0x8 | 0x4, 'F'},
}

var hotkeyNames = []string{"Strg+Alt+Leertaste", "Strg+Umschalt+Leertaste", "Strg+Alt+F", "Strg+Alt+S", "Win+Umschalt+F", "Keine"}

type msgT struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      [2]int32
	_       uint32
}

// StartHotkey registriert die Tastenkombination auf einem eigenen Thread.
// Rückgabe: Stopp-Funktion; Fehler, wenn die Kombination schon belegt ist.
func StartHotkey(name string, onPress func()) (stop func(), err error) {
	def, ok := hotkeys[name]
	if !ok {
		return func() {}, nil
	}
	tidCh := make(chan uint32)
	errCh := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid := windows.GetCurrentThreadId()
		const modNoRepeat = 0x4000
		if r, _, e := procRegisterHotKey.Call(0, 1, uintptr(def.mods|modNoRepeat), uintptr(def.vk)); r == 0 {
			errCh <- e
			tidCh <- 0
			return
		}
		errCh <- nil
		tidCh <- tid
		var m msgT
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				break
			}
			if m.Message == 0x0312 { // WM_HOTKEY
				onPress()
			}
		}
		procUnregisterHotKey.Call(0, 1)
	}()
	err = <-errCh
	tid := <-tidCh
	if err != nil {
		return func() {}, fmt.Errorf("%s ist bereits von einem anderen Programm belegt", name)
	}
	return func() { procPostThreadMessageW.Call(uintptr(tid), 0x0012 /* WM_QUIT */, 0, 0) }, nil
}

// ---------- Nur eine Instanz ----------

// SingleInstance: true = wir sind die erste Instanz. onActivate wird aufgerufen,
// wenn das Programm ein weiteres Mal gestartet wird.
func SingleInstance(onActivate func()) (first bool, notifyExisting func()) {
	name := windows.StringToUTF16Ptr(`Local\ERGOFORYOU-NasSuche-Anzeigen`)
	h, err := windows.CreateEvent(nil, 0, 0, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		return false, func() {
			procAllowSetForegroundWindow.Call(^uintptr(0)) // ASFW_ANY
			windows.SetEvent(h)
		}
	}
	if h != 0 {
		go func() {
			for {
				if ev, _ := windows.WaitForSingleObject(h, windows.INFINITE); ev == windows.WAIT_OBJECT_0 {
					onActivate()
				} else {
					return
				}
			}
		}()
	}
	return true, nil
}

// ---------- Autostart ----------

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runValue = "ERGOFORYOU NAS-Suche"
const runValueOld = "Ergo4U NAS-Suche" // frühere Version

func AutostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	if _, _, err = k.GetStringValue(runValue); err == nil {
		return true
	}
	_, _, err = k.GetStringValue(runValueOld)
	return err == nil
}

func SetAutostart(on bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	k.DeleteValue(runValueOld)
	if !on {
		if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue(runValue, `"`+exe+`" /tray`)
}

// ---------- Schrift aus der EXE laden ----------

func LoadFontFromMemory(data []byte) {
	var n uint32
	procAddFontMemResourceEx.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0, uintptr(unsafe.Pointer(&n)))
}
