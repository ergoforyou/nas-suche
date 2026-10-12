//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/lxn/walk"
	"github.com/lxn/win"
	"golang.org/x/sys/windows"
)

// Navigationsbaum links wie im Windows-Explorer: „Schnellzugriff“ (angeheftete Ordner)
// und „Netzlaufwerke“, beliebig aufklappbar. Klick zeigt den Ordner in der aktiven Ansicht.

type navItem struct {
	name     string
	path     string // leer bei Gruppen
	parent   *navItem
	children []*navItem
	loaded   bool
	group    int // 0 = Ordner, 1 = Schnellzugriff, 2 = Netzlaufwerke
	nav      *Navigator
}

func (it *navItem) Text() string { return it.name }

func (it *navItem) Parent() walk.TreeItem {
	if it.parent == nil {
		return nil
	}
	return it.parent
}

func (it *navItem) load() {
	if it.loaded {
		return
	}
	it.loaded = true
	if it.group != 0 {
		return // Gruppen werden von außen befüllt
	}
	for _, name := range it.nav.app.panes[0].subfolders(it.path) {
		it.children = append(it.children, &navItem{name: name, path: filepath.Join(it.path, name), parent: it, nav: it.nav})
	}
}

func (it *navItem) ChildCount() int             { it.load(); return len(it.children) }
func (it *navItem) ChildAt(i int) walk.TreeItem { return it.children[i] }

// HasChild: Ordner zeigen das Aufklapp-Dreieck, ohne vorher das NAS zu fragen.
func (it *navItem) HasChild() bool {
	if it.group != 0 || it.loaded {
		return len(it.children) > 0
	}
	return true
}

func (it *navItem) Image() interface{} {
	if ic := shellIcon("", true, 96); ic != nil {
		return ic
	}
	return nil
}

type navModel struct {
	walk.TreeModelBase
	roots []*navItem
}

func (m *navModel) LazyPopulation() bool       { return true }
func (m *navModel) RootCount() int             { return len(m.roots) }
func (m *navModel) RootAt(i int) walk.TreeItem { return m.roots[i] }

type Navigator struct {
	app   *App
	tv    *walk.TreeView
	model *navModel
	quick *navItem
	pc    *navItem
	nets  *navItem

	dropItem  win.HANDLE
	hoverItem win.HANDLE
	hoverAt   time.Time
}

func newNavigator(a *App) *Navigator {
	n := &Navigator{app: a, model: &navModel{}}
	n.quick = &navItem{name: "Schnellzugriff", group: 1, nav: n, loaded: true}
	n.pc = &navItem{name: "Dieser PC", group: 3, nav: n, loaded: true}
	n.nets = &navItem{name: "Netzlaufwerke", group: 2, nav: n, loaded: true}
	n.model.roots = []*navItem{n.quick, n.nets, n.pc}
	n.fill()
	return n
}

// fill baut die beiden Gruppen aus den Einstellungen auf.
func (n *Navigator) fill() {
	c := n.app.cfg
	n.quick.children = nil
	for _, f := range c.Favorites {
		n.quick.children = append(n.quick.children, &navItem{name: f.Name, path: f.Path, parent: n.quick, nav: n})
	}
	n.nets.children = nil
	seen := map[string]bool{}
	add := func(label, path string) {
		key := strings.ToLower(strings.TrimRight(path, `\`))
		if path == "" || seen[key] {
			return
		}
		seen[key] = true
		n.nets.children = append(n.nets.children, &navItem{name: label, path: path, parent: n.nets, nav: n})
	}
	for _, d := range c.Drives {
		if d.Letter != "" {
			add(d.Letter+"  ("+d.Remote+")", d.Letter+`\`)
		} else {
			add(d.Remote, d.Remote)
		}
	}
	for _, f := range c.Folders {
		add(f, f)
	}
	n.fillPC()
}

// fillPC: wie „Dieser PC“ im Explorer – persönliche Ordner und alle Laufwerke.
func (n *Navigator) fillPC() {
	n.pc.children = nil
	known := []struct {
		name string
		id   *windows.KNOWNFOLDERID
	}{
		{"Desktop", windows.FOLDERID_Desktop},
		{"Downloads", windows.FOLDERID_Downloads},
		{"Dokumente", windows.FOLDERID_Documents},
		{"Bilder", windows.FOLDERID_Pictures},
	}
	for _, k := range known {
		if p, err := windows.KnownFolderPath(k.id, 0); err == nil && p != "" {
			n.pc.children = append(n.pc.children, &navItem{name: k.name, path: p, parent: n.pc, nav: n})
		}
	}
	mask, _ := windows.GetLogicalDrives()
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 || i < 2 { // A:/B: (Diskette) auslassen
			continue
		}
		root := string(rune('A'+i)) + `:\`
		label := root[:2]
		switch windows.GetDriveType(windows.StringToUTF16Ptr(root)) {
		case windows.DRIVE_REMOTE:
			if r := CurrentConnection(root[:2]); r != "" {
				label += "  (" + r + ")"
			} else {
				label += "  (Netzlaufwerk)"
			}
		case windows.DRIVE_CDROM:
			label += "  (DVD)"
		case windows.DRIVE_REMOVABLE:
			label += "  (Wechseldatenträger)"
		default:
			label += "  (Lokaler Datenträger)"
		}
		n.pc.children = append(n.pc.children, &navItem{name: label, path: root, parent: n.pc, nav: n})
	}
}

func (n *Navigator) refresh() {
	n.fill()
	n.model.PublishItemsReset(nil)
	if n.tv != nil {
		n.tv.SetExpanded(n.quick, true)
		n.tv.SetExpanded(n.nets, true)
	}
}

func (n *Navigator) init() {
	n.tv.SetModel(n.model)
	n.tv.SetExpanded(n.quick, true)
	n.tv.SetExpanded(n.nets, true)
	n.tv.MouseDown().Attach(func(x, y int, b walk.MouseButton) {
		hti := win.TVHITTESTINFO{Pt: win.POINT{X: int32(x), Y: int32(y)}}
		win.SendMessage(n.tv.Handle(), tvmHitTest, 0, uintptr(unsafe.Pointer(&hti)))
		it, ok := n.tv.ItemAt(x, y).(*navItem)
		if !ok {
			return
		}
		switch {
		case b == walk.RightButton:
			n.contextMenu(it)
		case b == walk.LeftButton && hti.Flags&(0x2|0x4) != 0 && it.path != "":
			// Klick auf Name/Symbol (nicht auf das Aufklapp-Dreieck) → Ordner in der aktiven Ansicht zeigen
			p := n.app.activePane()
			path := it.path
			n.app.mw.Synchronize(func() { p.openFolder(path) })
		}
	})
	if err := RegisterDropTarget(uintptr(n.tv.Handle()), n); err != nil {
		dbg("Navigationsbaum Ablageziel: %v", err)
	}
}

func (n *Navigator) isPinned(path string) int {
	for i, f := range n.app.cfg.Favorites {
		if strings.EqualFold(f.Path, path) {
			return i
		}
	}
	return -1
}

// pin heftet einen Ordner an den Schnellzugriff an (wie im Explorer).
func (n *Navigator) pin(path string) {
	if n.isPinned(path) >= 0 {
		return
	}
	name := filepath.Base(path)
	if name == "" || name == `\` || name == "." {
		name = path
	}
	n.app.cfg.Favorites = append(n.app.cfg.Favorites, Favorite{Name: name, Path: path})
	n.app.cfg.Save()
	n.refresh()
	n.app.setStatus("„" + name + "“ ist an den Schnellzugriff angeheftet.")
}

func (n *Navigator) unpin(path string) {
	if i := n.isPinned(path); i >= 0 {
		f := n.app.cfg.Favorites
		n.app.cfg.Favorites = append(f[:i:i], f[i+1:]...)
		n.app.cfg.Save()
		n.refresh()
	}
}

func (n *Navigator) contextMenu(it *navItem) {
	if it.path == "" {
		return
	}
	a := n.app
	path := it.path
	items := []popItem{
		{text: "In linker Ansicht öffnen", action: func() { a.panes[0].openFolderLater(path) }},
		{text: "In rechter Ansicht öffnen", action: func() { a.setSecondPane(true); a.panes[1].openFolderLater(path) }},
		{text: "Im Explorer öffnen", action: func() { openExplorer(path, false) }},
		{separator: true},
	}
	if n.isPinned(path) >= 0 {
		items = append(items, popItem{text: "Vom Schnellzugriff lösen", action: func() { n.unpin(path) }})
	} else {
		items = append(items, popItem{text: "An Schnellzugriff anheften", action: func() { n.pin(path) }})
	}
	var pt win.POINT
	win.GetCursorPos(&pt)
	popupMenu(a.mw.Handle(), pt.X, pt.Y, items)
}

// ---------- Ablegen auf dem Baum ----------

const (
	tvmHitTest     = 0x1100 + 17
	tvmSelectItem  = 0x1100 + 11
	tvgnDropHilite = 0x0008
)

func (n *Navigator) hitTest(x, y int32) (win.HANDLE, *navItem) {
	pt := win.POINT{X: x, Y: y}
	win.ScreenToClient(n.tv.Handle(), &pt)
	hti := win.TVHITTESTINFO{Pt: pt}
	h := win.SendMessage(n.tv.Handle(), tvmHitTest, 0, uintptr(unsafe.Pointer(&hti)))
	if h == 0 {
		return 0, nil
	}
	it, _ := n.tv.ItemAt(int(pt.X), int(pt.Y)).(*navItem)
	return win.HANDLE(h), it
}

func (n *Navigator) setDrop(h win.HANDLE) {
	if h != n.dropItem {
		n.dropItem = h
		win.SendMessage(n.tv.Handle(), tvmSelectItem, tvgnDropHilite, uintptr(h))
	}
}

// expand klappt einen Eintrag per Programm auf. Die Bibliothek fügt Unterordner sonst nur beim
// Klick auf das Dreieck ein – deshalb vorher über das erste Kind das Einfügen auslösen.
func (n *Navigator) expand(it *navItem) {
	it.load()
	if len(it.children) > 0 {
		n.tv.SetExpanded(it.children[0], true)
		n.tv.SetExpanded(it.children[0], false)
	}
	n.tv.SetExpanded(it, true)
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func (n *Navigator) DropEffect(paths []string, keys uint32, x, y int32) uint32 {
	h, it := n.hitTest(x, y)
	if it == nil {
		n.setDrop(0)
		return dropEffectNone
	}
	// über einem Ordner verweilen → aufklappen (wie im Explorer)
	if h != n.hoverItem {
		n.hoverItem, n.hoverAt = h, time.Now()
	} else if time.Since(n.hoverAt) > springDelay && !n.tv.Expanded(it) {
		n.expand(it)
	}
	n.setDrop(h)
	if it.group == 1 {
		n.app.setStatus("Loslassen = Ordner an den Schnellzugriff anheften")
		for _, p := range paths {
			if isDir(p) {
				return dropEffectCopy
			}
		}
		return dropEffectNone
	}
	if it.path == "" {
		return dropEffectNone
	}
	for _, p := range paths {
		if strings.EqualFold(filepath.Dir(p), it.path) || strings.EqualFold(p, it.path) {
			return dropEffectNone
		}
	}
	if keys&mkControl != 0 {
		n.app.setStatus("Loslassen = KOPIEREN nach " + it.path)
		return dropEffectCopy
	}
	n.app.setStatus("Loslassen = VERSCHIEBEN nach " + it.path + "   (Strg gedrückt halten = kopieren)")
	return dropEffectMove
}

func (n *Navigator) Drop(paths []string, effect uint32, x, y int32) {
	_, it := n.hitTest(x, y)
	n.setDrop(0)
	if it == nil {
		return
	}
	list := append([]string(nil), paths...)
	if it.group == 1 {
		n.app.mw.Synchronize(func() {
			for _, p := range list {
				if isDir(p) {
					n.pin(p)
				}
			}
		})
		return
	}
	target := it.path
	n.app.mw.Synchronize(func() { n.app.transfer(list, target, effect == dropEffectMove) })
}

func (n *Navigator) DragLeave() {
	n.setDrop(0)
	n.hoverItem = 0
	n.app.setStatus(n.app.lastInfo)
}
