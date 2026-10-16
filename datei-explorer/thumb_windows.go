//go:build windows

package main

import (
	"errors"
	"image"
	"runtime"

	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procGetObjectW                  = gdi32.NewProc("GetObjectW")
	procGetDIBits                   = gdi32.NewProc("GetDIBits")
	procDeleteObject                = gdi32.NewProc("DeleteObject")
	procGetDC                       = user32.NewProc("GetDC")
	procReleaseDC                   = user32.NewProc("ReleaseDC")
	iidIShellItemImageFactory       = windows.GUID{Data1: 0xbcc18b79, Data2: 0xba16, Data3: 0x442f, Data4: [8]byte{0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b}}
)

type thumbJob struct {
	path string
	size int
	out  chan thumbResult
}

type thumbResult struct {
	img image.Image
	err error
}

var thumbJobs = make(chan thumbJob, 256)

func init() {
	// Vorschauen entstehen auf eigenen Threads mit COM (die Shell-Erweiterungen verlangen das).
	for i := 0; i < 3; i++ {
		go func() {
			runtime.LockOSThread()
			windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
			for j := range thumbJobs {
				img, err := shellThumbnail(j.path, j.size)
				j.out <- thumbResult{img, err}
			}
		}()
	}
}

func platformThumbnail(path string, size int) (image.Image, error) {
	out := make(chan thumbResult, 1)
	thumbJobs <- thumbJob{path, size, out}
	r := <-out
	return r.img, r.err
}

type bitmapInfo struct {
	Type, Width, Height, WidthBytes int32
	Planes, BitsPixel               uint16
	Bits                            uintptr
}

type bitmapInfoHeader struct {
	Size                      uint32
	Width, Height             int32
	Planes, BitCount          uint16
	Compression, SizeImage    uint32
	XPelsPerMeter, YPelsPerMe int32
	ClrUsed, ClrImportant     uint32
}

// shellThumbnail fragt die Windows-Shell nach der Miniatur (IShellItemImageFactory).
func shellThumbnail(path string, size int) (image.Image, error) {
	var factory uintptr
	hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(path))), 0,
		uintptr(unsafe.Pointer(&iidIShellItemImageFactory)), uintptr(unsafe.Pointer(&factory)))
	if hr != 0 || factory == 0 {
		return nil, errors.New("keine Vorschau")
	}
	defer comRelease(factory)
	var hbm uintptr
	sz := uintptr(uint32(size)) | uintptr(uint32(size))<<32 // SIZE wird als Wert übergeben
	const siigbfResizeToFit = 0
	if hr := comCall(factory, 3, sz, siigbfResizeToFit, uintptr(unsafe.Pointer(&hbm))); hr != 0 || hbm == 0 {
		return nil, errors.New("keine Vorschau")
	}
	defer procDeleteObject.Call(hbm)
	return hbitmapImage(hbm)
}

// hbitmapImage liest ein 32-Bit-Bild der Shell und legt es auf weißen Grund.
func hbitmapImage(hbm uintptr) (image.Image, error) {
	var bm bitmapInfo
	if r, _, _ := procGetObjectW.Call(hbm, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 || bm.Width <= 0 || bm.Height == 0 {
		return nil, errors.New("Bild nicht lesbar")
	}
	w, h := int(bm.Width), int(bm.Height)
	if h < 0 {
		h = -h
	}
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	buf := make([]byte, w*h*4)
	hdc, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, hdc)
	if r, _, _ := procGetDIBits.Call(hdc, hbm, 0, uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return nil, errors.New("Bild nicht lesbar")
	}
	anyAlpha := false
	for i := 3; i < len(buf); i += 4 {
		if buf[i] != 0 {
			anyAlpha = true
			break
		}
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(buf); i += 4 {
		b, g, r, a := int(buf[i]), int(buf[i+1]), int(buf[i+2]), int(buf[i+3])
		if !anyAlpha {
			a = 255
		}
		// vormultipliziertes Alpha auf Weiß
		add := 255 - a
		img.Pix[i] = clamp8(r + add)
		img.Pix[i+1] = clamp8(g + add)
		img.Pix[i+2] = clamp8(b + add)
		img.Pix[i+3] = 255
	}
	return img, nil
}

func clamp8(v int) uint8 {
	if v > 255 {
		return 255
	}
	return uint8(v)
}
