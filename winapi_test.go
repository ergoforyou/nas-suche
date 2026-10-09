//go:build windows

package main

import (
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procDragQueryFileW = shell32.NewProc("DragQueryFileW")

func hdropFiles(h uintptr) []string {
	n, _, _ := procDragQueryFileW.Call(h, 0xFFFFFFFF, 0, 0)
	var out []string
	for i := uintptr(0); i < n; i++ {
		buf := make([]uint16, 1024)
		procDragQueryFileW.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), 1024)
		out = append(out, windows.UTF16ToString(buf))
	}
	return out
}

// Paketvariablen liegen fest im Speicher (Go-Stapelvariablen können wandern).
var (
	testFE   formatEtc
	testMed  stgMedium
	testEnum uintptr
	testUnk  uintptr
)

func TestDataObject(t *testing.T) {
	initVtbls()
	dragPaths = []string{`C:\a\Müller 1.pdf`, `\\nas\daten\b.docx`}
	this := uintptr(unsafe.Pointer(dataObj))
	call := func(i int, args ...uintptr) uintptr {
		r, _, _ := syscall.SyscallN(dataObj.vtbl[i], append([]uintptr{this}, args...)...)
		return r
	}
	testFE = formatEtc{CfFormat: cfHDROP, Aspect: 1, Lindex: -1, Tymed: tymedHGlobal}
	if r := call(5, uintptr(unsafe.Pointer(&testFE))); r != 0 {
		t.Fatalf("QueryGetData: %x", r)
	}
	if r := call(3, uintptr(unsafe.Pointer(&testFE)), uintptr(unsafe.Pointer(&testMed))); r != 0 {
		t.Fatalf("GetData: %x", r)
	}
	got := hdropFiles(testMed.HGlobal)
	if len(got) != 2 || got[0] != dragPaths[0] || got[1] != dragPaths[1] {
		t.Fatalf("HDROP: %q", got)
	}
	if r := call(8, 1, uintptr(unsafe.Pointer(&testEnum))); r != 0 || testEnum == 0 {
		t.Fatalf("EnumFormatEtc: %x", r)
	}
	if r := call(0, uintptr(unsafe.Pointer(&iidIDataObject)), uintptr(unsafe.Pointer(&testUnk))); r != 0 || testUnk != this {
		t.Fatalf("QueryInterface")
	}
}

func TestClipboardFiles(t *testing.T) {
	paths := []string{`C:\x\Angebot Müller.pdf`, `C:\y\z.txt`}
	if err := CopyFilesToClipboard(0, paths); err != nil {
		t.Fatal(err)
	}
	procOpenClipboard.Call(0)
	defer procCloseClipboard.Call()
	h, _, _ := user32.NewProc("GetClipboardData").Call(cfHDROP)
	if got := hdropFiles(h); len(got) != 2 || got[0] != paths[0] {
		t.Fatalf("Zwischenablage: %q", got)
	}
}

func TestShareRoot(t *testing.T) {
	if ShareRoot(`\\DiskStation\Daten\Kunden\x`) != `\\DiskStation\Daten` || ShareRoot(`Z:\x`) != "" {
		t.Fatal("ShareRoot")
	}
}
