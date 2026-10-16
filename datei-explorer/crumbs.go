//go:build windows

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"

	"github.com/lxn/walk"
	"github.com/lxn/win"
)

// Pfadleiste wie im Explorer: „Y: › Kunden › PW › Wrobel ›“. Klick auf ein Teilstück springt dorthin,
// Klick auf „›“ klappt die Unterordner dieser Ebene auf.

type crumb struct {
	label string // angezeigter Name
	path  string // vollständiger Pfad bis hier
}

// pathCrumbs zerlegt einen Pfad in seine Ebenen (Laufwerk bzw. \\Server\Freigabe zuerst).
func pathCrumbs(dir string) []crumb {
	dir = filepath.Clean(dir)
	vol := filepath.VolumeName(dir)
	root := vol + `\`
	out := []crumb{{label: vol, path: root}}
	rest := strings.Trim(dir[len(vol):], `\`)
	if rest == "" {
		return out
	}
	cur := root
	for _, part := range strings.Split(rest, `\`) {
		cur = filepath.Join(cur, part)
		out = append(out, crumb{label: part, path: cur})
	}
	return out
}

// subfolders liefert die Unterordner (sortiert wie im Explorer, ohne ausgeschlossene).
func (p *Pane) subfolders(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	excl := map[string]bool{}
	for _, e := range p.app.cfg.Excludes {
		excl[strings.ToLower(e)] = true
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() && !excl[strings.ToLower(e.Name())] && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(strings.ToLower(out[i]), strings.ToLower(out[j])) })
	return out
}

var crumbFont *walk.Font

const maxCrumbs = 5 // so viele Ebenen werden angezeigt, davor „…“

// crumbSlot: ein fester Knopf-Platz (Ebene + „›“), wird nur umbeschriftet, nie neu erzeugt.
type crumbSlot struct {
	btn, arrow *walk.PushButton
	c          crumb
	next       string
}

func (p *Pane) initCrumbs() {
	if crumbFont == nil {
		crumbFont, _ = walk.NewFont("Segoe UI", 10, walk.FontBold)
	}
	p.crumbMore, _ = walk.NewPushButton(p.crumbs)
	p.crumbMore.SetText("…")
	p.crumbMore.SetMinMaxSize(walk.Size{Width: 26}, walk.Size{Width: 26})
	p.crumbMore.Clicked().Attach(func() { p.openFolderLater(p.crumbMorePath) })
	for i := 0; i < maxCrumbs; i++ {
		sl := &crumbSlot{}
		sl.btn, _ = walk.NewPushButton(p.crumbs)
		sl.arrow, _ = walk.NewPushButton(p.crumbs)
		sl.arrow.SetText("›")
		sl.arrow.SetMinMaxSize(walk.Size{Width: 22}, walk.Size{Width: 22})
		sl.btn.Clicked().Attach(func() { p.openFolderLater(sl.c.path) })
		sl.arrow.Clicked().Attach(func() { p.showSubfolderMenu(sl.arrow, sl.c.path, sl.next) })
		p.crumbSlots = append(p.crumbSlots, sl)
	}
}

func (p *Pane) buildCrumbs(dir string) {
	if len(p.crumbSlots) == 0 {
		p.initCrumbs()
	}
	cs := pathCrumbs(dir)
	start := 0
	if len(cs) > maxCrumbs {
		start = len(cs) - maxCrumbs
	}
	p.crumbMore.SetVisible(start > 0)
	if start > 0 {
		p.crumbMorePath = cs[start-1].path
		p.crumbMore.SetToolTipText(cs[start-1].path)
	}
	normal := p.crumbMore.Font()
	for i, sl := range p.crumbSlots {
		k := start + i
		if k >= len(cs) {
			sl.btn.SetVisible(false)
			sl.arrow.SetVisible(false)
			continue
		}
		sl.c = cs[k]
		sl.next = ""
		if k+1 < len(cs) {
			sl.next = cs[k+1].label
		}
		sl.btn.SetText(strings.ReplaceAll(sl.c.label, "&", "&&"))
		if k == len(cs)-1 {
			sl.btn.SetFont(crumbFont) // aktueller Ordner fett
		} else {
			sl.btn.SetFont(normal)
		}
		sl.arrow.SetToolTipText("Unterordner von " + sl.c.label + " anzeigen")
		sl.btn.SetVisible(true)
		sl.arrow.SetVisible(true)
	}
	p.pathBar.RequestLayout()
}

var (
	procCreatePopupMenu = user32.NewProc("CreatePopupMenu")
	procAppendMenuW     = user32.NewProc("AppendMenuW")
	procTrackPopupMenu  = user32.NewProc("TrackPopupMenu")
	procDestroyMenu     = user32.NewProc("DestroyMenu")
)

// showSubfolderMenu klappt unter dem „›“-Knopf die Unterordner auf.
func (p *Pane) showSubfolderMenu(btn *walk.PushButton, dir, current string) {
	subs := p.subfolders(dir)
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)
	const mfString, mfGrayed, mfChecked, mfMenuBarBreak = 0x0, 0x1, 0x8, 0x20
	if len(subs) == 0 {
		procAppendMenuW.Call(hMenu, mfString|mfGrayed, 0, uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("(keine Unterordner)"))))
	}
	for i, s := range subs {
		flags := uintptr(mfString)
		if strings.EqualFold(s, current) {
			flags |= mfChecked
		}
		if i > 0 && i%30 == 0 {
			flags |= mfMenuBarBreak // lange Listen in Spalten nebeneinander
		}
		procAppendMenuW.Call(hMenu, flags, uintptr(i+1), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(strings.ReplaceAll(s, "&", "&&")))))
	}
	var rc win.RECT
	win.GetWindowRect(btn.Handle(), &rc)
	const tpmReturnCmd, tpmLeftAlign, tpmTopAlign = 0x0100, 0x0000, 0x0000
	cmd, _, _ := procTrackPopupMenu.Call(hMenu, tpmReturnCmd|tpmLeftAlign|tpmTopAlign,
		uintptr(rc.Left), uintptr(rc.Bottom), 0, uintptr(p.app.mw.Handle()), 0)
	if i := int(cmd) - 1; i >= 0 && i < len(subs) {
		p.openFolderLater(filepath.Join(dir, subs[i]))
	}
}

// openFolderLater: erst nach dem Klick umbauen (der angeklickte Knopf wird dabei entfernt).
func (p *Pane) openFolderLater(dir string) {
	p.app.mw.Synchronize(func() { p.openFolder(dir) })
}
