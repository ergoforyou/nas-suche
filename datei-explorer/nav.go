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

// Ordnerbaum jeder Seite wie im Windows-Explorer: „Schnellzugriff“ (angeheftete Ordner),
// „Netzlaufwerke“ und „Dieser PC“ mit der vollständigen Ordner-Hierarchie, beliebig aufklappbar.
// Klick zeigt den Ordner in dieser Seite; der Baum folgt dem geöffneten Ordner.

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
	for _, name := range it.nav.pane.subfolders(it.path) {
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
	pane  *Pane // Seite, zu der dieser Baum gehört
	tv    *walk.TreeView
	model *navModel
	quick *navItem
	pc    *navItem
	nets  *navItem

	dropItem  win.HANDLE
	hoverItem win.HANDLE
	hoverAt   time.Time
}

func newNavigator(a *App, p *Pane) *Navigator {
	n := &Navigator{app: a, pane: p, model: &navModel{}}
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
			p := n.pane
			path := it.path
			n.app.mw.Synchronize(func() { p.openFolder(path); p.focusView() })
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
	n.app.refreshNavs()
	n.app.setStatus("„" + name + "“ ist an den Schnellzugriff angeheftet.")
}

func (n *Navigator) unpin(path string) {
	if i := n.isPinned(path); i >= 0 {
		f := n.app.cfg.Favorites
		n.app.cfg.Favorites = append(f[:i:i], f[i+1:]...)
		n.app.cfg.Save()
		n.app.refreshNavs()
	}
}

func (n *Navigator) contextMenu(it *navItem) {
	if it.path == "" {
		return
	}
	a := n.app
	path := it.path
	items := []popItem{
		{text: "Links öffnen", action: func() { a.panes[0].openFolderLater(path) }},
		{text: "Rechts öffnen", action: func() { a.panes[1].openFolderLater(path) }},
		{text: "Einfügen", disabled: !ClipboardHasFiles(), action: func() { a.pasteInto(path) }},
		{text: "Eigenschaften", action: func() { ShowProperties(uintptr(a.mw.Handle()), []string{path}) }},
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

// ---------- Baum folgt dem geöffneten Ordner ----------

// samePathPrefix: liegt p in (oder ist) dir?
func samePathPrefix(p, dir string) bool {
	lp, ld := strings.ToLower(filepath.Clean(p)), strings.ToLower(strings.TrimRight(filepath.Clean(dir), `\`))
	return lp == ld || strings.HasPrefix(lp, ld+`\`)
}

// reveal klappt den Baum bis zum Ordner auf und markiert ihn (wie der Windows-Explorer).
func (n *Navigator) reveal(dir string) {
	if n.tv == nil || !n.tv.Visible() || dir == "" {
		return
	}
	// Ausgangspunkt: das längste passende Laufwerk bzw. die Freigabe unter Netzlaufwerke / Dieser PC
	var cur *navItem
	for _, g := range []*navItem{n.nets, n.pc} {
		for _, it := range g.children {
			if it.path != "" && samePathPrefix(dir, it.path) && (cur == nil || len(it.path) > len(cur.path)) {
				cur = it
			}
		}
	}
	if cur == nil {
		return
	}
	if cur.parent != nil {
		n.tv.SetExpanded(cur.parent, true) // Gruppe zuerst öffnen, sonst gibt es die Einträge noch nicht
	}
	for depth := 0; depth < 40 && !strings.EqualFold(filepath.Clean(cur.path), filepath.Clean(dir)); depth++ {
		cur.load()
		var next *navItem
		for _, c := range cur.children {
			if samePathPrefix(dir, c.path) {
				next = c
				break
			}
		}
		if next == nil {
			break
		}
		n.expand(cur)
		cur = next
	}
	if strings.EqualFold(filepath.Clean(cur.path), filepath.Clean(dir)) {
		n.expand(cur) // den aktuellen Ordner selbst aufklappen – seine Unterordner sind gleich anklickbar
	}
	n.tv.SetCurrentItem(cur)
}

// invalidate liest die Unterordner eines angezeigten Ordners beim nächsten Aufklappen neu
// (nach Neuer Ordner, Umbenennen, Verschieben, Löschen).
func (n *Navigator) invalidate(dir string) {
	var find func(list []*navItem) *navItem
	find = func(list []*navItem) *navItem {
		for _, it := range list {
			if it.path != "" && strings.EqualFold(filepath.Clean(it.path), filepath.Clean(dir)) {
				return it
			}
			if it.loaded && it.path != "" && samePathPrefix(dir, it.path) || it.group != 0 {
				if f := find(it.children); f != nil {
					return f
				}
			}
		}
		return nil
	}
	it := find(n.model.roots)
	if it == nil || !it.loaded || it.group != 0 {
		return
	}
	old := make(map[string]bool, len(it.children))
	for _, c := range it.children {
		old[strings.ToLower(c.name)] = true
	}
	subs := n.pane.subfolders(it.path)
	same := len(subs) == len(old)
	for _, s := range subs {
		same = same && old[strings.ToLower(s)]
	}
	if same {
		return
	}
	expanded := n.tv.Expanded(it)
	it.children, it.loaded = nil, false
	n.model.PublishItemsReset(it)
	if expanded {
		n.expand(it)
	}
}
