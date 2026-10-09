//go:build windows

package main

import (
	"os"
	"strings"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
)

func (a *App) showSettings() {
	var (
		dlg        *walk.Dialog
		lb         *walk.ListBox
		pathEdit   *walk.LineEdit
		exclEdit   *walk.LineEdit
		hours      *walk.NumberEdit
		workers    *walk.NumberEdit
		driveLB    *walk.ListBox
		letterCB   *walk.ComboBox
		remoteEdit *walk.LineEdit
		sharedEdit *walk.LineEdit
		writerCB   *walk.CheckBox
		hotkeyCB   *walk.ComboBox
		autoCB     *walk.CheckBox
	)
	folders := append([]string(nil), a.cfg.Folders...)
	drives := append([]DriveMap(nil), a.cfg.Drives...)
	letters := []string{"(ohne Buchstabe)"}
	for c := 'D'; c <= 'Z'; c++ {
		letters = append(letters, string(c)+":")
	}
	hotkeyIdx := 0
	for i, n := range hotkeyNames {
		if n == a.cfg.Hotkey {
			hotkeyIdx = i
		}
	}

	// Werte werden beim Klick auf „Speichern" übernommen (danach sind die Felder nicht mehr verfügbar).
	var (
		newExcl    []string
		newHours   int
		newWorkers int
		newShared  string
		newWriter  bool
		newHotkey  string
		newAuto    bool
	)

	driveStrings := func() []string {
		var s []string
		for _, d := range drives {
			s = append(s, d.String())
		}
		return s
	}

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

	note := func(text string) Widget {
		return Label{Text: text, TextColor: walk.RGB(0x55, 0x5F, 0x6B)}
	}

	res, err := Dialog{
		AssignTo: &dlg,
		Title:    "Einstellungen – " + brandName + " " + brandProduct,
		MinSize:  Size{Width: 680, Height: 520},
		Layout:   VBox{},
		Children: []Widget{
			TabWidget{
				Pages: []TabPage{
					{
						Title:  "Suchordner",
						Layout: VBox{},
						Children: []Widget{
							Label{Text: "Diese Ordner / Netzlaufwerke werden durchsucht (inkl. aller Unterordner):"},
							ListBox{AssignTo: &lb, Model: folders, MinSize: Size{Height: 130}},
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
							VSpacer{Size: 6},
							Label{Text: "Ignorieren (Datei-/Ordnernamen, durch ; getrennt):"},
							LineEdit{AssignTo: &exclEdit, Text: strings.Join(a.cfg.Excludes, "; ")},
							VSpacer{},
						},
					},
					{
						Title:  "Netzlaufwerke",
						Layout: VBox{},
						Children: []Widget{
							Label{Text: "Diese Netzlaufwerke werden bei jedem Programmstart automatisch verbunden:"},
							ListBox{AssignTo: &driveLB, Model: driveStrings(), MinSize: Size{Height: 130}},
							Composite{
								Layout: HBox{MarginsZero: true},
								Children: []Widget{
									ComboBox{AssignTo: &letterCB, Model: letters, CurrentIndex: len(letters) - 1},
									LineEdit{AssignTo: &remoteEdit, CueBanner: `\\DiskStation\Freigabe`},
									PushButton{Text: "Hinzufügen", OnClicked: func() {
										r := strings.TrimRight(strings.TrimSpace(remoteEdit.Text()), `\`)
										if ShareRoot(r) == "" {
											walk.MsgBox(dlg, "Netzlaufwerk", `Bitte einen Netzwerkpfad angeben, z. B. \\DiskStation\Daten`, walk.MsgBoxIconInformation)
											return
										}
										l := ""
										if i := letterCB.CurrentIndex(); i > 0 {
											l = letters[i]
										}
										for _, d := range drives {
											if l != "" && strings.EqualFold(d.Letter, l) {
												walk.MsgBox(dlg, "Netzlaufwerk", l+" ist in der Liste schon vergeben.", walk.MsgBoxIconInformation)
												return
											}
										}
										drives = append(drives, DriveMap{Letter: l, Remote: r})
										driveLB.SetModel(driveStrings())
										remoteEdit.SetText("")
									}},
									PushButton{Text: "Entfernen", OnClicked: func() {
										if i := driveLB.CurrentIndex(); i >= 0 && i < len(drives) {
											drives = append(drives[:i], drives[i+1:]...)
											driveLB.SetModel(driveStrings())
										}
									}},
								},
							},
							note("Fehlen Benutzername oder Kennwort, fragt Windows einmal nach. Mit „Anmeldedaten speichern“\n" +
								"merkt sich Windows diese sicher in der Anmeldeinformationsverwaltung – das Programm speichert keine Kennwörter."),
							VSpacer{},
						},
					},
					{
						Title:  "Gemeinsamer Index",
						Layout: VBox{},
						Children: []Widget{
							Label{Text: "Ordner auf dem NAS für den gemeinsamen Index (leer = jeder PC liest selbst ein):"},
							Composite{
								Layout: HBox{MarginsZero: true},
								Children: []Widget{
									LineEdit{AssignTo: &sharedEdit, Text: a.cfg.SharedIndexDir, CueBanner: `z. B. \\DiskStation\Daten\_NasSuche`},
									PushButton{Text: "Auswählen …", OnClicked: func() {
										fd := &walk.FileDialog{Title: "Ordner für den gemeinsamen Index"}
										if ok, _ := fd.ShowBrowseFolder(dlg); ok {
											sharedEdit.SetText(fd.FilePath)
										}
									}},
								},
							},
							CheckBox{AssignTo: &writerCB, Text: "Dieser PC erstellt und aktualisiert den gemeinsamen Index (nur an EINEM PC aktivieren)",
								Checked: a.cfg.SharedWriter},
							VSpacer{Size: 6},
							note("So funktioniert es: Ein PC (Haken gesetzt) liest das NAS regelmäßig ein und legt den Index\n" +
								"im Ordner oben ab. Alle anderen PCs laden ihn nur noch herunter – in wenigen Sekunden."),
							note("Wichtig: Auf dem erstellenden PC die Suchordner als Netzwerkpfad (\\\\DiskStation\\…) eintragen,\n" +
								"damit die Pfade auf allen PCs passen – oder überall dieselben Laufwerksbuchstaben verwenden."),
							note("Tipp: Eine Datei NasSuche.json neben der EXE gibt diese Einstellungen für alle Kollegen vor."),
							VSpacer{},
						},
					},
					{
						Title:  "Allgemein",
						Layout: Grid{Columns: 2},
						Children: []Widget{
							Label{Text: "Suche öffnen mit Tastenkombination:"},
							ComboBox{AssignTo: &hotkeyCB, Model: hotkeyNames, CurrentIndex: hotkeyIdx},
							Label{Text: "Mit Windows starten (im Hintergrund):"},
							CheckBox{AssignTo: &autoCB, Checked: AutostartEnabled()},
							Label{Text: "Index automatisch aktualisieren alle (Stunden, 0 = nie):"},
							NumberEdit{AssignTo: &hours, Value: float64(a.cfg.RefreshHours), MinValue: 0, MaxValue: 720, Decimals: 0, MaxSize: Size{Width: 80}},
							Label{Text: "Gleichzeitige Zugriffe beim Einlesen (1–64):"},
							NumberEdit{AssignTo: &workers, Value: float64(a.cfg.Workers), MinValue: 1, MaxValue: 64, Decimals: 0, MaxSize: Size{Width: 80}},
							Composite{ColumnSpan: 2, Layout: VBox{MarginsZero: true}, Children: []Widget{
								VSpacer{Size: 8},
								note("Das Fenster-Schließen (X) beendet das Programm nicht – es läuft unten rechts neben der Uhr weiter.\n" +
									"Beenden: Rechtsklick auf das Symbol → „Beenden“."),
							}},
							VSpacer{ColumnSpan: 2},
						},
					},
				},
			},
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
						newShared = strings.TrimSpace(strings.Trim(strings.TrimSpace(sharedEdit.Text()), `"`))
						newWriter = writerCB.Checked() && newShared != ""
						newHotkey = hotkeyNames[max(0, hotkeyCB.CurrentIndex())]
						newAuto = autoCB.Checked()
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

	c := a.cfg
	foldersChanged := !sameRoots(folders, c.Folders) || strings.Join(newExcl, ";") != strings.Join(c.Excludes, ";")
	drivesChanged := len(drives) != len(c.Drives)
	for i := 0; !drivesChanged && i < len(drives); i++ {
		drivesChanged = drives[i] != c.Drives[i]
	}
	sharedChanged := !strings.EqualFold(newShared, c.SharedIndexDir) || newWriter != c.SharedWriter

	c.Folders, c.Excludes, c.Drives = folders, newExcl, drives
	c.RefreshHours = newHours
	if newWorkers > 0 {
		c.Workers = newWorkers
	}
	c.SharedIndexDir, c.SharedWriter = newShared, newWriter
	hotkeyChanged := newHotkey != c.Hotkey
	c.Hotkey = newHotkey
	if err := c.Save(); err != nil {
		walk.MsgBox(a.mw, brandProduct, "Einstellungen konnten nicht gespeichert werden:\n"+err.Error(), walk.MsgBoxIconError)
	}
	if newAuto != AutostartEnabled() {
		if err := SetAutostart(newAuto); err != nil {
			walk.MsgBox(a.mw, brandProduct, "Autostart konnte nicht geändert werden:\n"+err.Error(), walk.MsgBoxIconError)
		}
	}
	if hotkeyChanged || a.hotkeyErr != "" {
		a.applyHotkey()
	}
	a.updateInfo()

	go func() {
		if drivesChanged || sharedChanged || foldersChanged {
			a.connectDrives(drivesChanged)
		}
		a.mw.Synchronize(func() {
			switch {
			case c.sharedReader() && sharedChanged:
				go a.pullShared(c.sharedIndexPath(), true)
			case !c.sharedReader() && (foldersChanged || sharedChanged) && len(c.Folders) > 0:
				if a.indexing {
					a.stopIndex.Store(true)
					a.setStatus("Einstellungen geändert – bitte nach dem Abbruch F5 drücken.")
					return
				}
				a.startIndex()
			}
		})
	}()
}
