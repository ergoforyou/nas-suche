//go:build windows

package main

import (
	"strings"
	"syscall"
	"unsafe"

	"github.com/lxn/walk"
	"github.com/lxn/win"
)

// Darstellung der Trefferliste: Windows-Symbole, farbige Typ-Spalte, hervorgehobene Ordner.

var (
	colorFolderBG = walk.RGB(0xFF, 0xF4, 0xD6) // zartes Gelb für Ordnerzeilen
	colorTreeBG   = walk.RGB(0xEA, 0xF3, 0xFC) // aufgeklappte Unterordner beim Ziehen
	catColors     = map[uint8]walk.Color{
		CatFolder: walk.RGB(0x9A, 0x67, 0x00), // dunkles Gelb/Braun
		CatPDF:    walk.RGB(0xC6, 0x28, 0x28), // Rot
		CatImage:  walk.RGB(0x2E, 0x7D, 0x32), // Grün
		CatOffice: walk.RGB(0x15, 0x65, 0xC0), // Blau
		CatOther:  walk.RGB(0x61, 0x61, 0x61), // Grau
	}
	boldFont  *walk.Font
	iconCache = map[string]*walk.Icon{}
)

// shellIcon holt das kleine Windows-Symbol für einen Dateityp – nur anhand der Endung,
// ohne auf das NAS zuzugreifen.
func shellIcon(name string, isDir bool, dpi int) *walk.Icon {
	key := "|dir"
	path := "ordner"
	attr := uint32(0x10) // FILE_ATTRIBUTE_DIRECTORY
	if !isDir {
		key = fileExt(strings.ToLower(name))
		path = "datei." + key
		attr = 0x80 // FILE_ATTRIBUTE_NORMAL
	}
	if ic, ok := iconCache[key]; ok {
		return ic
	}
	var sfi win.SHFILEINFO
	flags := uint32(win.SHGFI_ICON | win.SHGFI_SMALLICON | win.SHGFI_USEFILEATTRIBUTES)
	var ic *walk.Icon
	if r := win.SHGetFileInfo(syscall.StringToUTF16Ptr(path), attr, &sfi, uint32(unsafe.Sizeof(sfi)), flags); r != 0 && sfi.HIcon != 0 {
		ic, _ = walk.NewIconFromHICONForDPI(sfi.HIcon, dpi)
	}
	iconCache[key] = ic
	return ic
}

// styleCell färbt die Zellen einer Trefferliste.
func (p *Pane) styleCell(style *walk.CellStyle) {
	e, _ := p.model.entry(style.Row())
	if e == nil {
		return
	}
	cat := categoryOf(strings.ToLower(e.Name), e.IsDir)
	if p.model.depthOf(style.Row()) > 0 {
		style.BackgroundColor = colorTreeBG // aufgeklappte Unterordner (Baum) hellblau
		style.TextColor = walk.RGB(0x10, 0x3A, 0x6B)
	} else if e.IsDir {
		style.BackgroundColor = colorFolderBG
		if boldFont == nil {
			boldFont, _ = walk.NewFont("Segoe UI", 9, walk.FontBold)
		}
		if style.Col() == 0 || style.Col() == 1 {
			style.Font = boldFont
		}
	}
	if style.Row() == p.dropRow {
		style.BackgroundColor = colorDropRow
		style.TextColor = colorDropText
		if boldFont == nil {
			boldFont, _ = walk.NewFont("Segoe UI", 9, walk.FontBold)
		}
		style.Font = boldFont
	}
	switch style.Col() {
	case 0:
		if ic := shellIcon(e.Name, e.IsDir, p.tv.DPI()); ic != nil {
			style.Image = ic
		}
	case 1:
		if c, ok := catColors[cat]; ok && style.Row() != p.dropRow {
			style.TextColor = c
		}
	}
}

var procFindWindowExW = user32.NewProc("FindWindowExW")

// onlyNameIcons: Symbole nur in der ersten Spalte (die Bibliothek schaltet sie für alle Spalten ein).
func onlyNameIcons(tv *walk.TableView) {
	const lvmSetExtendedListViewStyle = 0x1000 + 54
	const lvsExSubItemImages = 0x00000002
	cls := syscall.StringToUTF16Ptr("SysListView32")
	var child uintptr
	for {
		child, _, _ = procFindWindowExW.Call(uintptr(tv.Handle()), child, uintptr(unsafe.Pointer(cls)), 0)
		if child == 0 {
			return
		}
		win.SendMessage(win.HWND(child), lvmSetExtendedListViewStyle, lvsExSubItemImages, 0)
	}
}
