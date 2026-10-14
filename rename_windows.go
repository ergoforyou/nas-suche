//go:build windows

package main

// Umbenennen im Programmfenster (F2 / Rechtsklick): eine Datei, oder mehrere gemeinsam
// mit Nummer – „Rechnung Müller (1).pdf“, „(2)“ … (wie im Explorer).

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
)

func (p *Pane) rename() {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	a := p.app
	first := filepath.Base(paths[0])
	value := first
	if len(paths) > 1 {
		value = strings.TrimSuffix(first, filepath.Ext(first))
	}
	title, hint := "Umbenennen", "Neuer Name:"
	if len(paths) > 1 {
		title = fmt.Sprintf("%d Elemente umbenennen", len(paths))
		hint = "Gemeinsamer Name – die Elemente werden in der angezeigten Reihenfolge durchnummeriert,\ndie Dateiendungen bleiben:"
	}
	var dlg *walk.Dialog
	var edit *walk.LineEdit
	var okBt, cancelBt *walk.PushButton
	name := ""
	err := Dialog{
		AssignTo:      &dlg,
		DefaultButton: &okBt,
		CancelButton:  &cancelBt,
		Title:         title,
		MinSize:       Size{Width: 480},
		Layout:        VBox{},
		Children: []Widget{
			Label{Text: hint},
			LineEdit{AssignTo: &edit, Text: value},
			Composite{Layout: HBox{MarginsZero: true}, Children: []Widget{
				HSpacer{},
				PushButton{AssignTo: &okBt, Text: "Umbenennen", OnClicked: func() { name = strings.TrimSpace(edit.Text()); dlg.Accept() }},
				PushButton{AssignTo: &cancelBt, Text: "Abbrechen", OnClicked: func() { dlg.Cancel() }},
			}},
		},
	}.Create(a.mw)
	if err != nil {
		return
	}
	// wie im Explorer: nur den Namen ohne Endung markieren
	// Positionen zählt das Eingabefeld in UTF-16-Zeichen (wichtig bei Umlauten)
	if dot := strings.LastIndex(value, "."); dot > 0 && len(paths) == 1 && !isDir(paths[0]) {
		edit.SetTextSelection(0, len(utf16.Encode([]rune(value[:dot]))))
	} else {
		edit.SetTextSelection(0, len(utf16.Encode([]rune(value))))
	}
	edit.SetFocus()
	if res := dlg.Run(); res != walk.DlgCmdOK || name == "" {
		return
	}

	moves := map[string]string{}
	var errs []string
	for i, src := range paths {
		n := name
		if len(paths) > 1 {
			n = fmt.Sprintf("%s (%d)", name, i+1)
			if !isDir(src) {
				n += filepath.Ext(src)
			}
		} else if !isDir(src) && !strings.EqualFold(filepath.Ext(n), filepath.Ext(src)) {
			if walk.MsgBox(a.mw, "Dateiendung ändern?", fmt.Sprintf("Die Endung wird von „%s“ zu „%s“ geändert.\nDanach lässt sich die Datei eventuell nicht mehr öffnen.",
				filepath.Ext(src), filepath.Ext(n)), walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != walk.DlgCmdYes {
				return
			}
		}
		dst, err := renamePath(src, n)
		if err != nil {
			errs = append(errs, filepath.Base(src)+": "+err.Error())
			continue
		}
		if dst != src {
			moves[src] = dst
		}
	}
	a.applyMoves(moves)
	if len(errs) > 0 {
		walk.MsgBox(a.mw, title, strings.Join(errs, "\n"), walk.MsgBoxIconWarning)
	}
	p.setStatus(fmt.Sprintf("%d Element(e) umbenannt.", len(moves)))
}
