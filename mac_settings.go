//go:build !windows

package main

import (
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
	pathEntry.SetPlaceHolder("z. B. /Volumes/Daten")
	addPath := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
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
	sharesEntry := widget.NewMultiLineEntry()
	sharesEntry.SetText(strings.Join(shares, "\n"))
	sharesEntry.SetPlaceHolder("smb://DiskStation/Daten   (eine Freigabe pro Zeile)")
	sharesEntry.SetMinRowsVisible(3)

	exclEntry := widget.NewEntry()
	exclEntry.SetText(strings.Join(c.Excludes, "; "))
	hoursEntry := widget.NewEntry()
	hoursEntry.SetText(strconv.Itoa(c.RefreshHours))

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

	d := dialog.NewCustomConfirm("Einstellungen – "+brandName+" "+brandProduct, "Speichern", "Abbrechen",
		container.NewVScroll(form), func(ok bool) {
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
				a.mountShares()
				if changed && len(c.Folders) > 0 {
					a.startIndex()
				}
			}()
		}, a.w)
	d.Resize(fyne.NewSize(700, 640))
	d.Show()
}
