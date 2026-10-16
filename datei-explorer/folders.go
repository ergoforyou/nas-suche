//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
	"golang.org/x/sys/windows"
)

// Feste Ordner („Ordner ▼“), Startordner und automatische Aktualisierung geöffneter Ordner.

func (p *Pane) startFolder() *string {
	if p.idx == 0 {
		return &p.app.cfg.StartFolder
	}
	return &p.app.cfg.StartFolder2
}

// openStartFolders zeigt beim Start links und rechts einen Ordner: den festen Startordner,
// sonst den zuletzt benutzten, sonst Suchordner bzw. Dokumente/Desktop.
func (a *App) openStartFolders() {
	docs, _ := windows.KnownFolderPath(windows.FOLDERID_Documents, 0)
	desk, _ := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0)
	first := ""
	if len(a.cfg.Folders) > 0 {
		first = a.cfg.Folders[0]
	}
	cands := [2][]string{
		{a.cfg.StartFolder, a.cfg.LastFolder, first, docs, `C:\`},
		{a.cfg.StartFolder2, a.cfg.LastFolder2, docs, desk, `C:\`},
	}
	for i, p := range a.panes {
		if p.model.folder != "" {
			continue
		}
		for _, c := range cands[i] {
			if c != "" && isDir(c) {
				p.openFolderSel(c, "")
				break
			}
		}
	}
}

// autoRefreshFolders: geöffnete Ordner alle 5 Sekunden still neu lesen – neue Scans erscheinen von selbst.
func (a *App) autoRefreshFolders() {
	for range time.Tick(5 * time.Second) {
		a.mw.Synchronize(func() {
			if !a.mw.Visible() || win.IsIconic(a.mw.Handle()) {
				return
			}
			for _, p := range a.panes {
				p.loadFolder(true, "")
			}
			a.updateCommands()
		})
	}
}

func (p *Pane) dragging() bool {
	return p.app.dragSource || p.dropRow >= 0 || p.dropWhole || p.model.expanded
}

func sameItems(a, b []Entry) bool {
	if len(a) != len(b) {
		return false
	}
	m := make(map[string]Entry, len(a))
	for _, e := range a {
		m[e.Name] = e
	}
	for _, e := range b {
		if o, ok := m[e.Name]; !ok || o.Size != e.Size || o.Mod != e.Mod {
			return false
		}
	}
	return true
}

func (p *Pane) reselect(paths []string) {
	want := map[string]bool{}
	for _, s := range paths {
		want[strings.ToLower(s)] = true
	}
	var idx []int
	for i := 0; i < p.model.RowCount(); i++ {
		if want[strings.ToLower(p.model.path(i))] {
			idx = append(idx, i)
		}
	}
	if len(idx) > 0 {
		p.tv.SetCurrentIndex(idx[0])
		p.tv.SetSelectedIndexes(idx)
		p.tv.EnsureItemVisible(idx[0])
	}
}

// ---------- Menü „Ordner ▼“ ----------

type popItem struct {
	text      string
	checked   bool
	disabled  bool
	separator bool
	sub       []popItem
	action    func()
}

// popupMenu zeigt ein Windows-Kontextmenü an der Bildschirmposition und führt die Auswahl aus.
func popupMenu(owner win.HWND, x, y int32, items []popItem) {
	var actions []func()
	var build func(items []popItem) uintptr
	build = func(items []popItem) uintptr {
		h, _, _ := procCreatePopupMenu.Call()
		for _, it := range items {
			const mfString, mfGrayed, mfChecked, mfPopup, mfSeparator = 0x0, 0x1, 0x8, 0x10, 0x800
			text := uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(strings.ReplaceAll(it.text, "&", "&&"))))
			switch {
			case it.separator:
				procAppendMenuW.Call(h, mfSeparator, 0, 0)
			case it.sub != nil:
				flags := uintptr(mfPopup)
				if it.disabled {
					flags |= mfGrayed
				}
				procAppendMenuW.Call(h, flags, build(it.sub), text)
			default:
				flags := uintptr(mfString)
				if it.checked {
					flags |= mfChecked
				}
				if it.disabled {
					flags |= mfGrayed
				}
				actions = append(actions, it.action)
				procAppendMenuW.Call(h, flags, uintptr(len(actions)), text)
			}
		}
		return h
	}
	h := build(items)
	defer procDestroyMenu.Call(h) // zerstört Untermenüs mit
	const tpmReturnCmd = 0x0100
	cmd, _, _ := procTrackPopupMenu.Call(h, tpmReturnCmd, uintptr(x), uintptr(y), 0, uintptr(owner), 0)
	if i := int(cmd) - 1; i >= 0 && i < len(actions) && actions[i] != nil {
		actions[i]()
	}
}

func (p *Pane) showFolderMenu() {
	a := p.app
	cur := p.model.folder
	var items []popItem
	for _, f := range a.cfg.Favorites {
		f := f
		items = append(items, popItem{text: f.Name, checked: strings.EqualFold(f.Path, cur),
			action: func() { p.openFolderLater(f.Path) }})
	}
	if len(a.cfg.Favorites) == 0 {
		items = append(items, popItem{text: "(noch keine festen Ordner – unten hinzufügen)", disabled: true})
	}
	items = append(items, popItem{separator: true})
	items = append(items, popItem{text: "Ordner auswählen und anzeigen …", action: func() {
		fd := &walk.FileDialog{Title: "Welcher Ordner soll angezeigt werden?"}
		if ok, _ := fd.ShowBrowseFolder(a.mw); ok && fd.FilePath != "" {
			p.openFolderLater(fd.FilePath)
		}
	}})
	items = append(items, popItem{text: "Angezeigten Ordner als festen Ordner merken …", disabled: cur == "",
		action: func() { p.addFavorite(cur) }})
	sf := p.startFolder()
	side := [2]string{"links", "rechts"}[p.idx]
	items = append(items, popItem{text: "Angezeigten Ordner beim Start " + side + " öffnen", disabled: cur == "",
		checked: cur != "" && strings.EqualFold(*sf, cur), action: func() {
			if strings.EqualFold(*sf, cur) {
				*sf = ""
			} else {
				*sf = cur
			}
			a.cfg.Save()
		}})
	if *sf != "" {
		items = append(items, popItem{text: "Startordner " + side + " entfernen (" + filepath.Base(*sf) + ")",
			action: func() { *sf = ""; a.cfg.Save() }})
	}
	if len(a.cfg.Favorites) > 0 {
		var del []popItem
		for i, f := range a.cfg.Favorites {
			i, f := i, f
			del = append(del, popItem{text: f.Name + "   (" + f.Path + ")", action: func() {
				a.cfg.Favorites = append(a.cfg.Favorites[:i:i], a.cfg.Favorites[i+1:]...)
				a.cfg.Save()
				a.nav.refresh()
				p.setStatus("„" + f.Name + "“ aus den festen Ordnern entfernt.")
			}})
		}
		items = append(items, popItem{text: "Festen Ordner entfernen", sub: del})
	}
	var rc win.RECT
	win.GetWindowRect(p.favBtn.Handle(), &rc)
	popupMenu(a.mw.Handle(), rc.Left, rc.Bottom, items)
}

// addFavorite fragt nach einem Namen und speichert den Ordner im Menü „Ordner ▼“.
func (p *Pane) addFavorite(dir string) {
	a := p.app
	name := filepath.Base(dir)
	var dlg *walk.Dialog
	var edit *walk.LineEdit
	res, err := Dialog{
		AssignTo: &dlg,
		Title:    "Festen Ordner merken",
		MinSize:  Size{Width: 420},
		Layout:   VBox{},
		Children: []Widget{
			Label{Text: "Name im Menü „★“ (z. B. Digitale Eingänge):"},
			LineEdit{AssignTo: &edit, Text: name},
			Label{Text: dir, TextColor: walk.RGB(0x55, 0x5F, 0x6B)},
			Composite{Layout: HBox{MarginsZero: true}, Children: []Widget{
				HSpacer{},
				PushButton{Text: "Speichern", OnClicked: func() { name = strings.TrimSpace(edit.Text()); dlg.Accept() }},
				PushButton{Text: "Abbrechen", OnClicked: func() { dlg.Cancel() }},
			}},
		},
	}.Run(a.mw)
	if err != nil || res != walk.DlgCmdOK || name == "" {
		return
	}
	for i, f := range a.cfg.Favorites {
		if strings.EqualFold(f.Path, dir) {
			a.cfg.Favorites[i].Name = name
			a.cfg.Save()
			a.nav.refresh()
			return
		}
	}
	a.cfg.Favorites = append(a.cfg.Favorites, Favorite{Name: name, Path: dir})
	a.cfg.Save()
	a.nav.refresh()
	p.setStatus("„" + name + "“ ist jetzt unter „★“ und im Schnellzugriff gespeichert – in beiden Ansichten.")
	if _, err := os.Stat(dir); err != nil {
		p.setStatus("Hinweis: " + dir + " ist gerade nicht erreichbar.")
	}
}
