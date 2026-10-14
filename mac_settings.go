//go:build !windows

package main

import (
	"path/filepath"
	"strconv"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

// showSettings: Suchordner, NAS-Freigaben, Ausschlüsse, Aktualisierung.
func (a *MacApp) showSettings() {
	c := a.cfg
	folders := append([]string(nil), c.Folders...)

	list := widget.NewList(
		func() int { return len(folders) },
		func() fyne.CanvasObject { return widget.NewLabel("") },
		func(i widget.ListItemID, o fyne.CanvasObject) { o.(*widget.Label).SetText(folders[i]) })
	sel := -1
	list.OnSelected = func(i widget.ListItemID) { sel = i }

	pathEntry := widget.NewEntry()
	pathEntry.SetPlaceHolder("z. B. /Volumes/Daten oder smb://DiskStation/Daten")
	var sharesEntry *widget.Entry
	addPath := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		// smb://Server/Freigabe/… → Freigabe beim Start verbinden, gesucht wird unter /Volumes/Freigabe/…
		if isNetworkPath(p) {
			u, sub := splitSMB(p)
			if shareName(u) == "" {
				dialog.ShowInformation("Freigabe fehlt", "Bitte die Freigabe mit angeben, z. B. "+u+"/Daten", a.w)
				return
			}
			if !strings.Contains(strings.ToLower(sharesEntry.Text), strings.ToLower(u)) {
				sharesEntry.SetText(strings.TrimSpace(sharesEntry.Text + "\n" + u))
			}
			local := mountPoint(u)
			if local == "" {
				local = filepath.Join("/Volumes", shareName(u))
			}
			p = filepath.Join(local, sub)
		}
		for _, f := range folders {
			if f == p {
				return
			}
		}
		folders = append(folders, p)
		list.Refresh()
	}
	choose := widget.NewButton("Ordner auswählen …", func() {
		if p, handled := chooseFolder("Suchordner auswählen (NAS-Freigaben stehen unter dem Servernamen bzw. /Volumes)"); handled {
			addPath(p)
			return
		}
		dialog.NewFolderOpen(func(u fyne.ListableURI, err error) {
			if err == nil && u != nil {
				addPath(u.Path())
			}
		}, a.w).Show()
	})
	remove := widget.NewButton("Entfernen", func() {
		if sel >= 0 && sel < len(folders) {
			folders = append(folders[:sel], folders[sel+1:]...)
			sel = -1
			list.UnselectAll()
			list.Refresh()
		}
	})
	add := widget.NewButton("Hinzufügen", func() { addPath(pathEntry.Text); pathEntry.SetText("") })

	var shares []string
	for _, d := range c.Drives {
		shares = append(shares, smbURL(d.Remote))
	}
	sharesEntry = widget.NewMultiLineEntry()
	sharesEntry.SetText(strings.Join(shares, "\n"))
	sharesEntry.SetPlaceHolder("smb://DiskStation/Daten   (eine Freigabe pro Zeile)")
	sharesEntry.SetMinRowsVisible(3)

	exclEntry := widget.NewEntry()
	exclEntry.SetText(strings.Join(c.Excludes, "; "))
	hoursEntry := widget.NewEntry()
	hoursEntry.SetText(strconv.Itoa(c.RefreshHours))

	loginCheck := widget.NewCheck("Beim Anmelden im Hintergrund starten (Suche im Browser sofort da, ohne Fenster)", nil)
	loginCheck.SetChecked(loginAgentEnabled())
	var dlg dialog.Dialog

	listBox := container.NewGridWrap(fyne.NewSize(620, 150), list)
	form := container.NewVBox(
		widget.NewLabelWithStyle("Diese Ordner werden durchsucht (inkl. Unterordner):", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		listBox,
		container.NewHBox(choose, remove),
		container.NewBorder(nil, nil, widget.NewLabel("Pfad eintippen:"), add, pathEntry),
		widget.NewSeparator(),
		widget.NewLabelWithStyle("NAS-Freigaben, die beim Start verbunden werden:", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		sharesEntry,
		widget.NewLabel("macOS fragt einmal nach Benutzer/Kennwort – „Im Schlüsselbund sichern“ anhaken.\nVerbundene Freigaben liegen unter /Volumes/… (diese als Suchordner eintragen)."),
		widget.NewSeparator(),
		container.NewBorder(nil, nil, widget.NewLabel("Ignorieren (durch ; getrennt):"), nil, exclEntry),
		container.NewBorder(nil, nil, widget.NewLabel("Index automatisch aktualisieren alle (Stunden, 0 = nie):"), nil, hoursEntry),
	)
	browserTab := container.NewVBox(
		widget.NewLabelWithStyle("Browser (Chrome, Edge, Opera, Brave):", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		widget.NewLabel("Die komplette Suche als Tab im Browser – Dateien direkt in WhatsApp, Gmail, Drive oder Claude ziehen."),
		container.NewHBox(widget.NewButton("NAS-Suche im Browser einrichten …", a.setupBrowser)),
		loginCheck,
		widget.NewSeparator(),
		widget.NewLabelWithStyle("Für Kollegen:", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		container.NewHBox(widget.NewButton("Als Vorgabe speichern …", a.exportDefaults),
			widget.NewButton("Vorgabe laden …", func() { a.importDefaults(func() { dlg.Hide() }) })),
		widget.NewLabel("Speichert Suchordner, NAS-Freigaben, feste Ordner und Startordner als NasSuche.json.\n"+
			"Liegt die Datei neben der App (z. B. im selben NAS-Ordner), übernehmen Kollegen sie beim ersten Start."),
	)
	tabs := container.NewAppTabs(
		container.NewTabItem("Suchordner & NAS", container.NewVScroll(form)),
		container.NewTabItem("Browser & Kollegen", browserTab),
	)

	d := dialog.NewCustomConfirm("Einstellungen – "+brandName+" "+brandProduct, "Speichern", "Abbrechen",
		tabs, func(ok bool) {
			if !ok {
				return
			}
			changed := !sameRoots(folders, c.Folders)
			c.Folders = folders
			var excl []string
			for _, e := range strings.Split(exclEntry.Text, ";") {
				if e = strings.TrimSpace(e); e != "" {
					excl = append(excl, e)
				}
			}
			if strings.Join(excl, ";") != strings.Join(c.Excludes, ";") {
				changed = true
			}
			c.Excludes = excl
			if h, err := strconv.Atoi(strings.TrimSpace(hoursEntry.Text)); err == nil && h >= 0 {
				c.RefreshHours = h
			}
			c.Drives = nil
			for _, l := range strings.Split(sharesEntry.Text, "\n") {
				if l = strings.TrimSpace(l); l != "" {
					c.Drives = append(c.Drives, DriveMap{Remote: smbURL(l)})
				}
			}
			c.Save()
			go func() {
				a.connectAndCheck(true)
				if changed && len(c.Folders) > 0 {
					a.startIndex()
				}
			}()
		}, a.w)
	dlg = d
	d.Resize(fyne.NewSize(720, 700))
	d.Show()
}
