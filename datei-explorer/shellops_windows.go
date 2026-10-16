//go:build windows

package main

// Explorer-Funktionen über die Windows-Shell: Löschen in den Papierkorb, Ausschneiden/Einfügen
// über die Zwischenablage (auch zwischen diesem Programm und dem Windows-Explorer), Eigenschaften,
// „Öffnen mit“, das vollständige Windows-Kontextmenü und Ziehen mit „Verschieben“ als Vorgabe.

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/lxn/win"
	"golang.org/x/sys/windows"
)

var (
	procSHObjectProperties     = shell32.NewProc("SHObjectProperties")
	procSHMultiFileProperties  = shell32.NewProc("SHMultiFileProperties")
	procSHBindToParent         = shell32.NewProc("SHBindToParent")
	procSHChangeNotify         = shell32.NewProc("SHChangeNotify")
	procGetClipboardData       = user32.NewProc("GetClipboardData")
	procIsClipboardFmtAvail    = user32.NewProc("IsClipboardFormatAvailable")
	procSetWindowsHookExW      = user32.NewProc("SetWindowsHookExW")
	procCallNextHookEx         = user32.NewProc("CallNextHookEx")
	procGetKeyState            = user32.NewProc("GetKeyState")
	procSetWindowLongPtrW      = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW        = user32.NewProc("CallWindowProcW")
	procTrackPopupMenuEx       = user32.NewProc("TrackPopupMenuEx")
	procGetMenuItemCount       = user32.NewProc("GetMenuItemCount")
	procGetCurrentThreadId     = kernel32.NewProc("GetCurrentThreadId")
	iidIShellFolder            = windows.GUID{Data1: 0x000214E6, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIContextMenu            = windows.GUID{Data1: 0x000214E4, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIContextMenu2           = windows.GUID{Data1: 0x000214F4, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIContextMenu3           = windows.GUID{Data1: 0xBCFCE0A0, Data2: 0xEC17, Data3: 0x11D0, Data4: [8]byte{0x8D, 0x10, 0x00, 0xA0, 0xC9, 0x0F, 0x27, 0x19}}
	cfPreferredDropEffect      uint32
	cfPreferredDropEffectReady bool
)

func preferredDropEffectFormat() uint32 {
	if !cfPreferredDropEffectReady {
		r, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Preferred DropEffect"))))
		cfPreferredDropEffect, cfPreferredDropEffectReady = uint32(r), true
	}
	return cfPreferredDropEffect
}

// comCall ruft Methode i eines COM-Objekts auf.
func comCall(obj uintptr, i int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(i)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// ---------- Datenobjekt der Shell (Ziehen, Eigenschaften) ----------

// shellDataObject liefert ein Shell-Datenobjekt für die Dateien (wie bei einer Auswahl im Explorer).
func shellDataObject(paths []string) (uintptr, error) {
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
		return 0, errors.New("keine der Dateien ist erreichbar")
	}
	desktop := [2]byte{} // leere ID-Liste = Desktop als gemeinsamer Ursprung
	var obj uintptr
	hr, _, _ := procSHCreateDataObject.Call(uintptr(unsafe.Pointer(&desktop[0])), uintptr(len(pidls)),
		uintptr(unsafe.Pointer(&pidls[0])), 0, uintptr(unsafe.Pointer(&iidIDataObject)), uintptr(unsafe.Pointer(&obj)))
	if hr != 0 || obj == 0 {
		return 0, fmt.Errorf("Shell-Datenobjekt nicht verfügbar (%x)", hr)
	}
	return obj, nil
}

// setPreferredEffect: „Preferred DropEffect“ im Datenobjekt – der Explorer verschiebt dann beim
// Ablegen, statt zu kopieren (auch auf ein anderes Laufwerk). Strg/Umschalt wirken wie gewohnt.
func setPreferredEffect(obj uintptr, effect uint32) {
	h, _, _ := procGlobalAlloc.Call(0x0002|0x0040, 4)
	if h == 0 {
		return
	}
	p, _, _ := procGlobalLock.Call(h)
	*(*uint32)(unsafe.Pointer(p)) = effect
	procGlobalUnlock.Call(h)
	fe := formatEtc{CfFormat: uint16(preferredDropEffectFormat()), Aspect: 1, Lindex: -1, Tymed: tymedHGlobal}
	med := stgMedium{Tymed: tymedHGlobal, HGlobal: h}
	if r := comCall(obj, 7, uintptr(unsafe.Pointer(&fe)), uintptr(unsafe.Pointer(&med)), 1); r != 0 {
		procGlobalFree.Call(h)
	}
}

// DragFilesMove startet Drag & Drop. Ziel Explorer/Desktop: Vorgabe VERSCHIEBEN (Strg = kopieren);
// Outlook, Browser usw. bekommen wie gewohnt eine Kopie.
func DragFilesMove(hwnd uintptr, paths []string, move bool) (uint32, error) {
	obj, err := shellDataObject(paths)
	if err != nil {
		return 0, dragFilesSimple(paths)
	}
	defer comRelease(obj)
	if move {
		setPreferredEffect(obj, dropEffectMove)
	}
	const dropEffectLink = 4
	var effect uint32
	procSHDoDragDrop.Call(hwnd, obj, 0, dropEffectCopy|dropEffectMove|dropEffectLink, uintptr(unsafe.Pointer(&effect)))
	return effect, nil
}

// ---------- Löschen ----------

// DeleteFiles löscht mit dem Windows-eigenen Dialog: recycle = in den Papierkorb (Entf),
// sonst endgültig (Umschalt+Entf). Windows fragt selbst nach.
func DeleteFiles(hwnd uintptr, paths []string, recycle bool) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	defer windows.CoUninitialize()
	const foDelete, fofAllowUndo, fofWantNukeWarning = 3, 0x40, 0x4000
	flags := uint16(0)
	if recycle {
		flags = fofAllowUndo | fofWantNukeWarning
	}
	op := shFileOpStruct{Hwnd: hwnd, Func: foDelete, From: doubleNull(paths), Flags: flags}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 && op.AnyOperationsAborted == 0 {
		return fmt.Errorf("Löschen fehlgeschlagen (Code %d)", r)
	}
	return nil
}

// CopyFilesRename kopiert in denselben oder einen anderen Ordner; gleiche Namen bekommen
// „ - Kopie“ (wie Strg+C / Strg+V im Explorer).
func CopyFilesRename(hwnd uintptr, paths []string, target string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	defer windows.CoUninitialize()
	const foCopy, fofRenameOnCollision, fofAllowUndo, fofNoConfirmMkdir = 2, 0x8, 0x40, 0x200
	op := shFileOpStruct{Hwnd: hwnd, Func: foCopy, From: doubleNull(paths), To: doubleNull([]string{target}),
		Flags: fofRenameOnCollision | fofAllowUndo | fofNoConfirmMkdir}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 && op.AnyOperationsAborted == 0 {
		return fmt.Errorf("Kopieren fehlgeschlagen (Code %d)", r)
	}
	return nil
}

// notifyChanged sagt dem Explorer, dass sich ein Ordner geändert hat (er aktualisiert sofort).
func notifyChanged(dir string) {
	const shcneUpdateDir, shcnfPathW = 0x00001000, 0x0005
	procSHChangeNotify.Call(shcneUpdateDir, shcnfPathW, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(dir))), 0)
}

// ---------- Zwischenablage ----------

// SetClipboardFiles legt Dateien in die Zwischenablage – move = Ausschneiden (Strg+X).
// Der Windows-Explorer versteht das genauso (Einfügen dort verschiebt bzw. kopiert).
func SetClipboardFiles(hwnd uintptr, paths []string, move bool) error {
	hDrop := makeHDrop(paths)
	if hDrop == 0 {
		return errors.New("GlobalAlloc fehlgeschlagen")
	}
	hEff, _, _ := procGlobalAlloc.Call(0x0002|0x0040, 4)
	if hEff != 0 {
		p, _, _ := procGlobalLock.Call(hEff)
		if move {
			*(*uint32)(unsafe.Pointer(p)) = dropEffectMove
		} else {
			*(*uint32)(unsafe.Pointer(p)) = dropEffectCopy | 4 // wie der Explorer: Kopieren + Verknüpfen
		}
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
		if r, _, _ := procSetClipboardData.Call(uintptr(preferredDropEffectFormat()), hEff); r == 0 {
			procGlobalFree.Call(hEff)
		}
	}
	return nil
}

// ClipboardHasFiles: liegen Dateien in der Zwischenablage (für „Einfügen“)?
func ClipboardHasFiles() bool {
	r, _, _ := procIsClipboardFmtAvail.Call(cfHDROP)
	return r != 0
}

// GetClipboardFiles liest Dateien aus der Zwischenablage – auch aus dem Windows-Explorer kopierte.
// move = sie wurden ausgeschnitten.
func GetClipboardFiles(hwnd uintptr) (paths []string, move bool, err error) {
	if r, _, _ := procOpenClipboard.Call(hwnd); r == 0 {
		return nil, false, errors.New("Zwischenablage ist gerade belegt")
	}
	defer procCloseClipboard.Call()
	h, _, _ := procGetClipboardData.Call(cfHDROP)
	if h == 0 {
		return nil, false, nil
	}
	paths = hdropPaths(h)
	if he, _, _ := procGetClipboardData.Call(uintptr(preferredDropEffectFormat())); he != 0 {
		if p, _, _ := procGlobalLock.Call(he); p != 0 {
			eff := *(*uint32)(unsafe.Pointer(p))
			procGlobalUnlock.Call(he)
			move = eff&dropEffectMove != 0 && eff&dropEffectCopy == 0
		}
	}
	return paths, move, nil
}

// ClearClipboard leert die Zwischenablage (nach dem Einfügen ausgeschnittener Dateien).
func ClearClipboard(hwnd uintptr) {
	if r, _, _ := procOpenClipboard.Call(hwnd); r != 0 {
		procEmptyClipboard.Call()
		procCloseClipboard.Call()
	}
}

// ---------- Eigenschaften, Öffnen mit ----------

// ShowProperties öffnet den Windows-Dialog „Eigenschaften“ (bei mehreren für alle zusammen).
func ShowProperties(hwnd uintptr, paths []string) {
	if len(paths) == 0 {
		return
	}
	if len(paths) > 1 {
		if obj, err := shellDataObject(paths); err == nil {
			procSHMultiFileProperties.Call(obj, 0)
			comRelease(obj)
			return
		}
	}
	const shopFilePath = 0x2
	procSHObjectProperties.Call(hwnd, shopFilePath, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(paths[0]))), 0)
}

// OpenWith zeigt die Windows-Auswahl „Öffnen mit …“.
func OpenWith(path string) {
	cmd := exec.Command("rundll32.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `rundll32.exe shell32.dll,OpenAs_RunDLL ` + path}
	cmd.Start()
}

// ---------- Vollständiges Windows-Kontextmenü („Weitere Optionen“) ----------

type cmInvokeCommandInfo struct {
	CbSize       uint32
	FMask        uint32
	Hwnd         uintptr
	LpVerb       uintptr
	LpParameters uintptr
	LpDirectory  uintptr
	NShow        int32
	DwHotKey     uint32
	HIcon        uintptr
}

var (
	cmActive2, cmActive3 uintptr // Kontextmenü, dessen Untermenüs („Senden an“, „Öffnen mit“) gerade gezeichnet werden
	cmOldProc            uintptr
	cmProc               uintptr
)

// cmWndProc leitet Menü-Nachrichten an das Shell-Kontextmenü weiter – sonst blieben
// Untermenüs wie „Senden an“ und „Öffnen mit“ leer.
func cmWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case win.WM_INITMENUPOPUP, win.WM_DRAWITEM, win.WM_MEASUREITEM, win.WM_MENUCHAR:
		if cmActive3 != 0 {
			var res uintptr
			if comCall(cmActive3, 7, msg, wp, lp, uintptr(unsafe.Pointer(&res))) == 0 {
				return res
			}
		} else if cmActive2 != 0 {
			if comCall(cmActive2, 6, msg, wp, lp) == 0 {
				if msg == win.WM_INITMENUPOPUP {
					return 0
				}
				return 1
			}
		}
	}
	r, _, _ := procCallWindowProcW.Call(cmOldProc, hwnd, msg, wp, lp)
	return r
}

// ShellContextMenu zeigt das Kontextmenü des Windows-Explorers für die Dateien (alle im selben
// Ordner) an der Bildschirmposition. true = ein Befehl wurde ausgeführt.
func ShellContextMenu(hwnd uintptr, paths []string, x, y int32, extended bool) (bool, error) {
	if len(paths) == 0 {
		return false, nil
	}
	var pidls []uintptr
	defer func() {
		for _, p := range pidls {
			procCoTaskMemFree.Call(p)
		}
	}()
	var folder uintptr
	var children []uintptr
	for i, p := range paths {
		var pidl uintptr
		hr, _, _ := procSHParseDisplayName.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(p))), 0,
			uintptr(unsafe.Pointer(&pidl)), 0, 0)
		if hr != 0 || pidl == 0 {
			continue
		}
		pidls = append(pidls, pidl)
		var sf, child uintptr
		if hr, _, _ := procSHBindToParent.Call(pidl, uintptr(unsafe.Pointer(&iidIShellFolder)),
			uintptr(unsafe.Pointer(&sf)), uintptr(unsafe.Pointer(&child))); hr != 0 {
			continue
		}
		if folder == 0 || i == 0 {
			if folder != 0 {
				comRelease(folder)
			}
			folder = sf
		} else {
			comRelease(sf) // gleicher Ordner wie das erste Element (Aufrufer sorgt dafür)
		}
		children = append(children, child)
	}
	if folder == 0 || len(children) == 0 {
		return false, errors.New("nicht erreichbar")
	}
	defer comRelease(folder)
	var cm uintptr
	if hr := comCall(folder, 10, hwnd, uintptr(len(children)), uintptr(unsafe.Pointer(&children[0])),
		uintptr(unsafe.Pointer(&iidIContextMenu)), 0, uintptr(unsafe.Pointer(&cm))); hr != 0 || cm == 0 {
		return false, fmt.Errorf("Kontextmenü nicht verfügbar (%x)", hr)
	}
	defer comRelease(cm)
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return false, errors.New("Menü nicht verfügbar")
	}
	defer procDestroyMenu.Call(hMenu)
	const idFirst, idLast = 1, 0x7FFF
	const cmfNormal, cmfExplore, cmfExtendedVerbs = 0x0, 0x4, 0x100
	flags := uintptr(cmfNormal | cmfExplore)
	if extended {
		flags |= cmfExtendedVerbs
	}
	if hr := comCall(cm, 3, hMenu, 0, idFirst, idLast, flags); int32(hr) < 0 {
		return false, fmt.Errorf("Kontextmenü nicht verfügbar (%x)", hr)
	}
	// Untermenüs: IContextMenu3/2 bekommen die Menü-Nachrichten des Fensters
	var cm2, cm3 uintptr
	comCall(cm, 0, uintptr(unsafe.Pointer(&iidIContextMenu3)), uintptr(unsafe.Pointer(&cm3)))
	if cm3 == 0 {
		comCall(cm, 0, uintptr(unsafe.Pointer(&iidIContextMenu2)), uintptr(unsafe.Pointer(&cm2)))
	}
	if cmProc == 0 {
		cmProc = syscall.NewCallback(cmWndProc)
	}
	cmActive2, cmActive3 = cm2, cm3
	const gwlpWndProc = ^uintptr(3) // -4
	cmOldProc, _, _ = procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, cmProc)
	const tpmReturnCmd, tpmRightButton = 0x0100, 0x0002
	cmd, _, _ := procTrackPopupMenuEx.Call(hMenu, tpmReturnCmd|tpmRightButton, uintptr(x), uintptr(y), hwnd, 0)
	procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, cmOldProc)
	cmActive2, cmActive3 = 0, 0
	if cm3 != 0 {
		comRelease(cm3)
	}
	if cm2 != 0 {
		comRelease(cm2)
	}
	if cmd < idFirst {
		return false, nil
	}
	ici := cmInvokeCommandInfo{Hwnd: hwnd, LpVerb: cmd - idFirst, NShow: win.SW_SHOWNORMAL}
	ici.CbSize = uint32(unsafe.Sizeof(ici))
	if hr := comCall(cm, 4, uintptr(unsafe.Pointer(&ici))); int32(hr) < 0 {
		return true, fmt.Errorf("Befehl fehlgeschlagen (%x)", hr)
	}
	return true, nil
}

// ---------- Tasten, die die Oberflächen-Bibliothek nicht meldet ----------

// Alt-Kombinationen und die Tasten der selbst gezeichneten Symbolansicht kommen über einen
// Tastatur-Haken nur für dieses Programm. handler liefert true, wenn die Taste verbraucht wurde.
var keyHandler func(vk uint32, alt bool) bool

func installKeyHook(handler func(vk uint32, alt bool) bool) {
	keyHandler = handler
	cb := syscall.NewCallback(func(code, wp, lp uintptr) uintptr {
		const altDown = 1 << 29
		const released = 1 << 31
		if int32(code) == 0 && lp&released == 0 && keyHandler != nil {
			if keyHandler(uint32(wp), lp&altDown != 0) {
				return 1
			}
		}
		r, _, _ := procCallNextHookEx.Call(0, code, wp, lp)
		return r
	})
	tid, _, _ := procGetCurrentThreadId.Call()
	const whKeyboard = 2
	procSetWindowsHookExW.Call(whKeyboard, cb, 0, tid)
}

func keyDown(vk int) bool {
	r, _, _ := procGetKeyState.Call(uintptr(vk))
	return int16(r) < 0
}

var _ = procGetMenuItemCount
