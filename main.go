//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

const maxResults = 100000

// ---------- Tabellenmodell ----------

type ResultModel struct {
	walk.TableModelBase
	walk.SorterBase
	ix      *Index
	rows    []int
	sortCol int
	asc     bool
}

func (m *ResultModel) RowCount() int { return len(m.rows) }

func (m *ResultModel) Value(row, col int) interface{} {
	if row >= len(m.rows) {
		return ""
	}
	e := &m.ix.Entries[m.rows[row]]
	switch col {
	case 0:
		return e.Name
	case 1:
		return m.ix.Dirs[e.Dir]
	case 2:
		if e.IsDir {
			return "Ordner"
		}
		return formatSize(e.Size)
	case 3:
		if e.Mod == 0 {
			return ""
		}
		return time.Unix(e.Mod, 0).Format("02.01.2006 15:04")
	}
	return ""
}

func (m *ResultModel) Sort(col int, order walk.SortOrder) error {
	m.sortCol, m.asc = col, order == walk.SortAscending
	if m.ix != nil {
		m.ix.SortResults(m.rows, m.sortCol, m.asc)
	}
	m.PublishRowsReset()
	return m.SorterBase.Sort(col, order)
}

func (m *ResultModel) set(ix *Index, rows []int) {
	m.ix, m.rows = ix, rows
	if ix != nil && m.sortCol >= 0 {
		ix.SortResults(m.rows, m.sortCol, m.asc)
	}
	m.PublishRowsReset()
}

func formatSize(n int64) string {
	f := float64(n)
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return strings.Replace(fmt.Sprintf("%.1f KB", f/1024), ".", ",", 1)
	case n < 1<<30:
		return strings.Replace(fmt.Sprintf("%.1f MB", f/(1<<20)), ".", ",", 1)
	default:
		return strings.Replace(fmt.Sprintf("%.2f GB", f/(1<<30)), ".", ",", 1)
	}
}

func thousands(n int64) string {
	s := fmt.Sprint(n)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// ---------- Anwendung ----------

type App struct {
	mw        *walk.MainWindow
	search    *walk.LineEdit
	kind      *walk.ComboBox
	inPath    *walk.CheckBox
	refreshBt *walk.PushButton
	tv        *walk.TableView
	status    *walk.StatusBarItem
	model     *ResultModel

	cfg       *Config
	ix        *Index
	searchGen atomic.Int64
	debounce  *time.Timer

	indexing  bool
	stopIndex atomic.Bool
	lastInfo  string
}

func main() {
	app := &App{cfg: LoadConfig(), model: &ResultModel{sortCol: 0, asc: true}}
	app.run()
}

func (a *App) run() {
	var icon interface{}
	if ic, err := walk.NewIconFromResourceId(1); err == nil {
		icon = ic
	} else if ic, err := walk.NewIconFromResource("APP"); err == nil {
		icon = ic
	}

	err := MainWindow{
		AssignTo: &a.mw,
		Title:    "NAS-Suche",
		Icon:     icon,
		MinSize:  Size{Width: 700, Height: 400},
		Size:     Size{Width: 1150, Height: 720},
		Layout:   VBox{},
		Children: []Widget{
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					Label{Text: "Suche:"},
					LineEdit{
						AssignTo:      &a.search,
						CueBanner:     "Dateiname eingeben … (mehrere Wörter = alle müssen vorkommen, z. B. angebot müller *.pdf)",
						OnTextChanged: a.scheduleSearch,
						OnKeyDown: func(key walk.Key) {
							if key == walk.KeyDown || key == walk.KeyReturn {
								if a.model.RowCount() > 0 {
									a.tv.SetFocus()
									a.tv.SetCurrentIndex(0)
								}
							}
						},
					},
					ComboBox{
						AssignTo:              &a.kind,
						Model:                 []string{"Dateien und Ordner", "Nur Dateien", "Nur Ordner"},
						CurrentIndex:          0,
						OnCurrentIndexChanged: a.scheduleSearch,
					},
					CheckBox{
						AssignTo:         &a.inPath,
						Text:             "Auch im Ordnerpfad suchen",
						Checked:          a.cfg.InPath,
						OnCheckedChanged: func() { a.cfg.InPath = a.inPath.Checked(); a.cfg.Save(); a.scheduleSearch() },
					},
					PushButton{AssignTo: &a.refreshBt, Text: "Index aktualisieren", OnClicked: a.toggleIndex},
					PushButton{Text: "Einstellungen …", OnClicked: a.showSettings},
				},
			},
			TableView{
				AssignTo:         &a.tv,
				AlternatingRowBG: true,
				MultiSelection:   true,
				Columns: []TableViewColumn{
					{Title: "Name", Width: 340},
					{Title: "Ordner", Width: 500},
					{Title: "Größe", Width: 90, Alignment: AlignFar},
					{Title: "Geändert", Width: 120},
				},
				Model:           a.model,
				OnItemActivated: a.openSelected,
				ContextMenuItems: []MenuItem{
					Action{Text: "Öffnen", OnTriggered: a.openSelected},
					Action{Text: "Im Ordner anzeigen", OnTriggered: a.showInFolder},
					Separator{},
					Action{Text: "Pfad kopieren", OnTriggered: func() { a.copySelected(true) }},
					Action{Text: "Name kopieren", OnTriggered: func() { a.copySelected(false) }},
				},
			},
		},
		StatusBarItems: []StatusBarItem{{AssignTo: &a.status, Width: 1100}},
	}.Create()
	if err != nil {
		walk.MsgBox(nil, "NAS-Suche", "Fehler beim Start: "+err.Error(), walk.MsgBoxIconError)
		return
	}

	a.tv.KeyDown().Attach(func(key walk.Key) {
		switch {
		case key == walk.KeyC && walk.ControlDown():
			a.copySelected(true)
		case key == walk.KeyF5:
			a.toggleIndex()
		}
	})
	a.mw.KeyDown().Attach(func(key walk.Key) {
		if key == walk.KeyF5 {
			a.toggleIndex()
		}
	})

	a.setStatus("Lade Index …")
	go a.startup()
	a.search.SetFocus()
	a.mw.Run()
	a.stopIndex.Store(true)
}

func (a *App) setStatus(s string) { a.status.SetText(" " + s) }

func (a *App) startup() {
	ix, _ := LoadIndex(indexPath())
	a.mw.Synchronize(func() {
		a.ix = ix
		a.updateInfo()
		if len(a.cfg.Folders) == 0 {
			walk.MsgBox(a.mw, "NAS-Suche – Willkommen",
				"Bitte legen Sie zuerst fest, welche Ordner bzw. Netzlaufwerke durchsucht werden sollen\n"+
					"(z. B. Z:\\ oder \\\\DiskStation\\Daten).", walk.MsgBoxIconInformation)
			a.showSettings()
			return
		}
		if a.ix == nil || !sameRoots(a.ix.Roots, a.cfg.Folders) ||
			(a.cfg.RefreshHours > 0 && time.Since(a.ix.Built) > time.Duration(a.cfg.RefreshHours)*time.Hour) {
			a.startIndex()
		}
		a.scheduleSearch()
	})

	// Automatische Aktualisierung, solange das Programm offen ist.
	for range time.Tick(5 * time.Minute) {
		a.mw.Synchronize(func() {
			if !a.indexing && a.ix != nil && a.cfg.RefreshHours > 0 &&
				time.Since(a.ix.Built) > time.Duration(a.cfg.RefreshHours)*time.Hour {
				a.startIndex()
			}
		})
	}
}

func sameRoots(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i]), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

func (a *App) updateInfo() {
	if a.ix == nil {
		a.lastInfo = "Noch kein Index vorhanden."
	} else {
		a.lastInfo = fmt.Sprintf("Index: %s Einträge, Stand %s", thousands(int64(len(a.ix.Entries))),
			a.ix.Built.Format("02.01.2006 15:04"))
		if a.ix.Errors > 0 {
			a.lastInfo += fmt.Sprintf(" (%d Ordner nicht lesbar)", a.ix.Errors)
		}
	}
	if !a.indexing {
		a.setStatus(a.lastInfo)
	}
}

// ---------- Indizierung ----------

func (a *App) toggleIndex() {
	if a.indexing {
		a.stopIndex.Store(true)
		a.setStatus("Breche ab …")
		return
	}
	if len(a.cfg.Folders) == 0 {
		a.showSettings()
		return
	}
	a.startIndex()
}

func (a *App) startIndex() {
	if a.indexing {
		return
	}
	a.indexing = true
	a.stopIndex.Store(false)
	a.refreshBt.SetText("Abbrechen")
	folders := append([]string(nil), a.cfg.Folders...)
	excludes := append([]string(nil), a.cfg.Excludes...)
	workers := a.cfg.Workers

	p := &Progress{}
	p.Current.Store("")
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(300 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				cur, _ := p.Current.Load().(string)
				msg := fmt.Sprintf("Lese Ordner ein … %s Einträge in %s Ordnern – %s",
					thousands(p.Files.Load()), thousands(p.Folders.Load()), cur)
				a.mw.Synchronize(func() { a.setStatus(msg) })
			}
		}
	}()

	go func() {
		start := time.Now()
		ix := BuildIndex(folders, excludes, workers, &a.stopIndex, p)
		close(done)
		cancelled := a.stopIndex.Load()
		if !cancelled {
			SaveIndex(ix, indexPath())
		}
		a.mw.Synchronize(func() {
			a.indexing = false
			a.refreshBt.SetText("Index aktualisieren")
			if cancelled {
				a.updateInfo()
				a.setStatus("Einlesen abgebrochen. " + a.lastInfo)
				return
			}
			a.ix = ix
			a.updateInfo()
			a.setStatus(fmt.Sprintf("%s (eingelesen in %s)", a.lastInfo, time.Since(start).Round(time.Second)))
			a.scheduleSearch()
		})
	}()
}

// ---------- Suche ----------

func (a *App) scheduleSearch() {
	gen := a.searchGen.Add(1)
	if a.debounce != nil {
		a.debounce.Stop()
	}
	a.debounce = time.AfterFunc(150*time.Millisecond, func() {
		a.mw.Synchronize(func() { a.runSearch(gen) })
	})
}

func (a *App) runSearch(gen int64) {
	if gen != a.searchGen.Load() {
		return
	}
	ix := a.ix
	q := Query{Text: a.search.Text(), Kind: a.kind.CurrentIndex(), InPath: a.inPath.Checked(), MaxResult: maxResults}
	if ix == nil || strings.TrimSpace(q.Text) == "" {
		a.model.set(ix, nil)
		if !a.indexing {
			a.setStatus(a.lastInfo)
		}
		return
	}
	go func() {
		start := time.Now()
		res, total := ix.Search(q, func() bool { return gen != a.searchGen.Load() })
		if gen != a.searchGen.Load() {
			return
		}
		el := time.Since(start)
		a.mw.Synchronize(func() {
			if gen != a.searchGen.Load() {
				return
			}
			a.model.set(ix, res)
			if !a.indexing {
				msg := fmt.Sprintf("%s Treffer (%d ms)", thousands(int64(total)), el.Milliseconds())
				if total > len(res) {
					msg += fmt.Sprintf(" – nur die ersten %s werden angezeigt, bitte Suche verfeinern", thousands(int64(len(res))))
				}
				a.setStatus(msg + "   |   " + a.lastInfo)
			}
		})
	}()
}

// ---------- Aktionen ----------

func (a *App) selectedPaths() []string {
	var out []string
	for _, i := range a.tv.SelectedIndexes() {
		if i < len(a.model.rows) {
			out = append(out, a.model.ix.Path(&a.model.ix.Entries[a.model.rows[i]]))
		}
	}
	if len(out) == 0 {
		if i := a.tv.CurrentIndex(); i >= 0 && i < len(a.model.rows) {
			out = append(out, a.model.ix.Path(&a.model.ix.Entries[a.model.rows[i]]))
		}
	}
	return out
}

func (a *App) openSelected() {
	paths := a.selectedPaths()
	if len(paths) > 10 {
		if walk.MsgBox(a.mw, "NAS-Suche", fmt.Sprintf("%d Dateien öffnen?", len(paths)),
			walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != walk.DlgCmdYes {
			return
		}
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			walk.MsgBox(a.mw, "NAS-Suche", "Nicht mehr vorhanden oder kein Zugriff:\n"+p+
				"\n\nTipp: Index aktualisieren (F5).", walk.MsgBoxIconWarning)
			continue
		}
		win.ShellExecute(a.mw.Handle(), syscall.StringToUTF16Ptr("open"),
			syscall.StringToUTF16Ptr(p), nil, nil, win.SW_SHOWNORMAL)
	}
}

func (a *App) showInFolder() {
	paths := a.selectedPaths()
	if len(paths) == 0 {
		return
	}
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + paths[0] + `"`}
	cmd.Start()
}

func (a *App) copySelected(full bool) {
	paths := a.selectedPaths()
	if !full {
		for i, p := range paths {
			paths[i] = p[strings.LastIndexAny(p, `\/`)+1:]
		}
	}
	if len(paths) > 0 {
		walk.Clipboard().SetText(strings.Join(paths, "\r\n"))
	}
}

// ---------- Einstellungen ----------

func (a *App) showSettings() {
	var (
		dlg      *walk.Dialog
		lb       *walk.ListBox
		pathEdit *walk.LineEdit
		exclEdit *walk.LineEdit
		hours    *walk.NumberEdit
		workers  *walk.NumberEdit
	)
	folders := append([]string(nil), a.cfg.Folders...)
	// Werte werden beim Klick auf „Speichern" übernommen (danach sind die Felder nicht mehr verfügbar).
	var (
		newExcl    []string
		newHours   int
		newWorkers int
	)

	addFolder := func(p string) {
		p = strings.TrimSpace(strings.Trim(strings.TrimSpace(p), `"`))
		if p == "" {
			return
		}
		if _, err := os.Stat(p); err != nil {
			if walk.MsgBox(dlg, "Ordner hinzufügen", "Der Ordner ist gerade nicht erreichbar:\n"+p+
				"\n\nTrotzdem hinzufügen?", walk.MsgBoxYesNo|walk.MsgBoxIconWarning) != walk.DlgCmdYes {
				return
			}
		}
		for _, f := range folders {
			if strings.EqualFold(f, p) {
				return
			}
		}
		folders = append(folders, p)
		lb.SetModel(folders)
	}

	res, err := Dialog{
		AssignTo: &dlg,
		Title:    "Einstellungen",
		MinSize:  Size{Width: 620, Height: 480},
		Layout:   VBox{},
		Children: []Widget{
			Label{Text: "Diese Ordner / Netzlaufwerke werden durchsucht (inkl. aller Unterordner):"},
			ListBox{AssignTo: &lb, Model: folders, MinSize: Size{Height: 140}},
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					PushButton{Text: "Ordner auswählen …", OnClicked: func() {
						fd := &walk.FileDialog{Title: "Ordner zum Durchsuchen auswählen"}
						if ok, _ := fd.ShowBrowseFolder(dlg); ok {
							addFolder(fd.FilePath)
						}
					}},
					PushButton{Text: "Entfernen", OnClicked: func() {
						if i := lb.CurrentIndex(); i >= 0 && i < len(folders) {
							folders = append(folders[:i], folders[i+1:]...)
							lb.SetModel(folders)
						}
					}},
					HSpacer{},
				},
			},
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					Label{Text: "Oder Pfad eintippen:"},
					LineEdit{AssignTo: &pathEdit, CueBanner: `z. B. \\DiskStation\Daten oder Z:\`},
					PushButton{Text: "Hinzufügen", OnClicked: func() {
						addFolder(pathEdit.Text())
						pathEdit.SetText("")
					}},
				},
			},
			VSpacer{Size: 8},
			Label{Text: "Ignorieren (Datei-/Ordnernamen, durch ; getrennt):"},
			LineEdit{AssignTo: &exclEdit, Text: strings.Join(a.cfg.Excludes, "; ")},
			Composite{
				Layout: Grid{Columns: 2, MarginsZero: true},
				Children: []Widget{
					Label{Text: "Index automatisch aktualisieren alle (Stunden, 0 = nie):"},
					NumberEdit{AssignTo: &hours, Value: float64(a.cfg.RefreshHours), MinValue: 0, MaxValue: 720, Decimals: 0, MaxSize: Size{Width: 80}},
					Label{Text: "Gleichzeitige Zugriffe beim Einlesen (1–64):"},
					NumberEdit{AssignTo: &workers, Value: float64(a.cfg.Workers), MinValue: 1, MaxValue: 64, Decimals: 0, MaxSize: Size{Width: 80}},
				},
			},
			Label{Text: "Hinweis: Der Index wird lokal auf diesem PC gespeichert. Die Suche selbst greift nicht auf das NAS zu\nund ist deshalb sofort da. Neue Dateien erscheinen nach der nächsten Aktualisierung (F5)."},
			VSpacer{},
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					HSpacer{},
					PushButton{Text: "Speichern", OnClicked: func() {
						for _, e := range strings.Split(exclEdit.Text(), ";") {
							if e = strings.TrimSpace(e); e != "" {
								newExcl = append(newExcl, e)
							}
						}
						newHours = int(hours.Value())
						newWorkers = int(workers.Value())
						dlg.Accept()
					}},
					PushButton{Text: "Abbrechen", OnClicked: func() { dlg.Cancel() }},
				},
			},
		},
	}.Run(a.mw)
	if err != nil || res != walk.DlgCmdOK {
		return
	}

	changed := !sameRoots(folders, a.cfg.Folders) || strings.Join(newExcl, ";") != strings.Join(a.cfg.Excludes, ";")
	a.cfg.Folders = folders
	a.cfg.Excludes = newExcl
	a.cfg.RefreshHours = newHours
	if newWorkers > 0 {
		a.cfg.Workers = newWorkers
	}
	if err := a.cfg.Save(); err != nil {
		walk.MsgBox(a.mw, "NAS-Suche", "Einstellungen konnten nicht gespeichert werden:\n"+err.Error(), walk.MsgBoxIconError)
	}
	if changed && len(folders) > 0 {
		if a.indexing {
			a.stopIndex.Store(true)
			walk.MsgBox(a.mw, "NAS-Suche", "Bitte nach dem Abbruch des laufenden Einlesens erneut „Index aktualisieren“ klicken.", walk.MsgBoxIconInformation)
			return
		}
		a.startIndex()
	}
}
