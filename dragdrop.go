//go:build windows

package main

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Eigene, minimale COM-Objekte (IDataObject + IDropSource) mit CF_HDROP.
// Werden genutzt, falls das Shell-Datenobjekt nicht verfügbar ist.

var (
	procDoDragDrop            = ole32.NewProc("DoDragDrop")
	procSHCreateStdEnumFmtEtc = shell32.NewProc("SHCreateStdEnumFmtEtc")

	iidIUnknown    = windows.GUID{Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIDropSource = windows.GUID{Data1: 0x00000121, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

const (
	cfHDROP       = 15
	tymedHGlobal  = 1
	sOK           = 0
	eNotImpl      = 0x80004001
	eNoInterface  = 0x80004002
	dvEFormatEtc  = 0x80040064
	oleEAdviseNot = 0x80040003
)

type formatEtc struct {
	CfFormat uint16
	_        [6]byte
	Ptd      uintptr
	Aspect   uint32
	Lindex   int32
	Tymed    uint32
	_        uint32
}

type stgMedium struct {
	Tymed          uint32
	_              uint32
	HGlobal        uintptr
	PUnkForRelease uintptr
}

type comObj struct {
	vtbl *[12]uintptr
}

var (
	dataObjVtbl [12]uintptr
	dropSrcVtbl [12]uintptr
	dataObj     = &comObj{vtbl: &dataObjVtbl}
	dropSrc     = &comObj{vtbl: &dropSrcVtbl}
	dragPaths   []string
	vtblsReady  bool
)

func guidAt(p uintptr) windows.GUID { return *(*windows.GUID)(unsafe.Pointer(p)) }

func initVtbls() {
	if vtblsReady {
		return
	}
	vtblsReady = true
	addRef := syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	release := syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	notImpl := syscall.NewCallback(func(this, a, b uintptr) uintptr { return eNotImpl })

	qi := func(own windows.GUID) uintptr {
		return syscall.NewCallback(func(this, riid, ppv uintptr) uintptr {
			g := guidAt(riid)
			if g == iidIUnknown || g == own {
				*(*uintptr)(unsafe.Pointer(ppv)) = this
				return sOK
			}
			*(*uintptr)(unsafe.Pointer(ppv)) = 0
			return eNoInterface
		})
	}

	// IDataObject
	dataObjVtbl = [12]uintptr{
		qi(iidIDataObject), addRef, release,
		// GetData
		syscall.NewCallback(func(this, pfe, pmed uintptr) uintptr {
			fe := (*formatEtc)(unsafe.Pointer(pfe))
			if fe.CfFormat != cfHDROP || fe.Tymed&tymedHGlobal == 0 {
				return dvEFormatEtc
			}
			h := makeHDrop(dragPaths)
			if h == 0 {
				return eNotImpl
			}
			med := (*stgMedium)(unsafe.Pointer(pmed))
			med.Tymed, med.HGlobal, med.PUnkForRelease = tymedHGlobal, h, 0
			return sOK
		}),
		notImpl, // GetDataHere
		// QueryGetData
		syscall.NewCallback(func(this, pfe uintptr) uintptr {
			fe := (*formatEtc)(unsafe.Pointer(pfe))
			if fe.CfFormat == cfHDROP && fe.Tymed&tymedHGlobal != 0 {
				return sOK
			}
			return dvEFormatEtc
		}),
		notImpl, // GetCanonicalFormatEtc
		syscall.NewCallback(func(this, a, b, c uintptr) uintptr { return eNotImpl }), // SetData
		// EnumFormatEtc
		syscall.NewCallback(func(this, dir, ppenum uintptr) uintptr {
			if dir != 1 { // DATADIR_GET
				return eNotImpl
			}
			fe := formatEtc{CfFormat: cfHDROP, Aspect: 1, Lindex: -1, Tymed: tymedHGlobal}
			r, _, _ := procSHCreateStdEnumFmtEtc.Call(1, uintptr(unsafe.Pointer(&fe)), ppenum)
			return r
		}),
		syscall.NewCallback(func(this, a, b, c, d uintptr) uintptr { return oleEAdviseNot }), // DAdvise
		syscall.NewCallback(func(this, a uintptr) uintptr { return oleEAdviseNot }),          // DUnadvise
		syscall.NewCallback(func(this, a uintptr) uintptr { return oleEAdviseNot }),          // EnumDAdvise
	}

	// IDropSource
	dropSrcVtbl[0], dropSrcVtbl[1], dropSrcVtbl[2] = qi(iidIDropSource), addRef, release
	dropSrcVtbl[3] = syscall.NewCallback(func(this, escape, keys uintptr) uintptr { // QueryContinueDrag
		const dragdropSDrop, dragdropSCancel, mkLButton = 0x40100, 0x40101, 0x1
		if uint32(escape) != 0 {
			return dragdropSCancel
		}
		if keys&mkLButton == 0 {
			return dragdropSDrop
		}
		return sOK
	})
	dropSrcVtbl[4] = syscall.NewCallback(func(this, effect uintptr) uintptr { return 0x40102 }) // GiveFeedback: Standard-Cursor
}

// makeHDrop erzeugt einen HGLOBAL mit DROPFILES + Pfadliste.
func makeHDrop(paths []string) uintptr {
	var buf []uint16
	for _, p := range paths {
		buf = append(buf, windows.StringToUTF16(p)...)
	}
	buf = append(buf, 0)
	const hdr = 20
	size := hdr + len(buf)*2
	h, _, _ := procGlobalAlloc.Call(0x0002|0x0040, uintptr(size))
	if h == 0 {
		return 0
	}
	ptr, _, _ := procGlobalLock.Call(h)
	mem := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), size)
	*(*uint32)(unsafe.Pointer(&mem[0])) = hdr
	*(*uint32)(unsafe.Pointer(&mem[16])) = 1
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(&mem[hdr])), len(buf)), buf)
	procGlobalUnlock.Call(h)
	return h
}

func dragFilesSimple(paths []string) error {
	initVtbls()
	dragPaths = paths
	var effect uint32
	dbg("DoDragDrop (eigenes Datenobjekt)")
	r, _, _ := procDoDragDrop.Call(uintptr(unsafe.Pointer(dataObj)), uintptr(unsafe.Pointer(dropSrc)),
		dropEffectCopy|dropEffectMove|4, uintptr(unsafe.Pointer(&effect)))
	if int32(r) < 0 {
		return syscall.Errno(r)
	}
	return nil
}

// ---------- Ablegen (IDropTarget) ----------

var (
	procRegisterDragDrop = ole32.NewProc("RegisterDragDrop")
	procReleaseStgMedium = ole32.NewProc("ReleaseStgMedium")
	procDragQueryFileW   = shell32.NewProc("DragQueryFileW")

	iidIDropTarget = windows.GUID{Data1: 0x00000122, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

const (
	dropEffectNone = 0
	dropEffectCopy = 1
	dropEffectMove = 2
	mkControl      = 0x8
)

// DropHandler entscheidet, ob und wohin abgelegt werden kann.
type DropHandler interface {
	// DropEffect: dropEffectNone, dropEffectCopy oder dropEffectMove (x/y = Bildschirmkoordinaten)
	DropEffect(paths []string, keys uint32, x, y int32) uint32
	Drop(paths []string, effect uint32, x, y int32)
	DragLeave()
}

type dropTarget struct {
	vtbl  *[7]uintptr
	h     DropHandler
	paths []string
}

var (
	dropVtbl    [7]uintptr
	dropTargets = map[uintptr]*dropTarget{} // hält die Objekte auch für den Garbage Collector fest
	dtFE        formatEtc                   // feste Speicherplätze für Windows-Aufrufe
	dtMed       stgMedium
)

func splitPt(pt uintptr) (int32, int32) { return int32(uint32(pt)), int32(uint32(pt >> 32)) }

func initDropVtbl() {
	if dropVtbl[0] != 0 {
		return
	}
	dropVtbl[0] = syscall.NewCallback(func(this, riid, ppv uintptr) uintptr {
		g := guidAt(riid)
		if g == iidIUnknown || g == iidIDropTarget {
			*(*uintptr)(unsafe.Pointer(ppv)) = this
			return sOK
		}
		*(*uintptr)(unsafe.Pointer(ppv)) = 0
		return eNoInterface
	})
	dropVtbl[1] = syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	dropVtbl[2] = syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	effect := func(dt *dropTarget, keys, pt uintptr) uint32 {
		if dt == nil || len(dt.paths) == 0 {
			return dropEffectNone
		}
		x, y := splitPt(pt)
		return dt.h.DropEffect(dt.paths, uint32(keys), x, y)
	}
	// DragEnter(this, dataObj, keys, pt, *effect)
	dropVtbl[3] = syscall.NewCallback(func(this, obj, keys, pt, pEff uintptr) uintptr {
		dt := dropTargets[this]
		dbg("DragEnter ziel=%v", dt != nil)
		if dt != nil {
			dt.paths = filesFromDataObject(obj)
		}
		*(*uint32)(unsafe.Pointer(pEff)) = effect(dt, keys, pt)
		return sOK
	})
	// DragOver(this, keys, pt, *effect)
	dropVtbl[4] = syscall.NewCallback(func(this, keys, pt, pEff uintptr) uintptr {
		*(*uint32)(unsafe.Pointer(pEff)) = effect(dropTargets[this], keys, pt)
		return sOK
	})
	// DragLeave(this)
	dropVtbl[5] = syscall.NewCallback(func(this uintptr) uintptr {
		if dt := dropTargets[this]; dt != nil {
			dt.paths = nil
			dt.h.DragLeave()
		}
		return sOK
	})
	// Drop(this, dataObj, keys, pt, *effect)
	dropVtbl[6] = syscall.NewCallback(func(this, obj, keys, pt, pEff uintptr) uintptr {
		dt := dropTargets[this]
		eff := effect(dt, keys, pt)
		if eff != dropEffectNone {
			x, y := splitPt(pt)
			dt.h.Drop(dt.paths, eff, x, y)
		}
		if dt != nil {
			dt.paths = nil
		}
		// Wir führen Verschieben selbst aus. Der Quelle melden wir „kopiert“, damit sie
		// die Originale nicht zusätzlich löscht.
		if eff == dropEffectMove {
			eff = dropEffectCopy
		}
		*(*uint32)(unsafe.Pointer(pEff)) = eff
		return sOK
	})
}

// RegisterDropTarget macht ein Fenster (samt Unterfenstern) zum Ablageziel für Dateien.
func RegisterDropTarget(hwnd uintptr, h DropHandler) error {
	initDropVtbl()
	dt := &dropTarget{vtbl: &dropVtbl, h: h}
	ptr := uintptr(unsafe.Pointer(dt))
	dropTargets[ptr] = dt
	if r, _, _ := procRegisterDragDrop.Call(hwnd, ptr); r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

func filesFromDataObject(obj uintptr) []string {
	if obj == 0 {
		return nil
	}
	vtbl := *(*[12]uintptr)(unsafe.Pointer(*(*uintptr)(unsafe.Pointer(obj))))
	dtFE = formatEtc{CfFormat: cfHDROP, Aspect: 1, Lindex: -1, Tymed: tymedHGlobal}
	dtMed = stgMedium{}
	if r, _, _ := syscall.SyscallN(vtbl[3], obj, uintptr(unsafe.Pointer(&dtFE)), uintptr(unsafe.Pointer(&dtMed))); r != 0 {
		return nil
	}
	defer procReleaseStgMedium.Call(uintptr(unsafe.Pointer(&dtMed)))
	return hdropPaths(dtMed.HGlobal)
}

func hdropPaths(h uintptr) []string {
	n, _, _ := procDragQueryFileW.Call(h, 0xFFFFFFFF, 0, 0)
	var out []string
	buf := make([]uint16, 32768)
	for i := uintptr(0); i < n; i++ {
		procDragQueryFileW.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		out = append(out, windows.UTF16ToString(buf))
	}
	return out
}
