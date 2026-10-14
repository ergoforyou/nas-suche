package main

import (
	"context"
	"os"
	"path/filepath"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func init() { api.DisableConfigDir() }

func mergeConf() *model.Configuration {
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	conf.CreateBookmarks = true
	return conf
}

func tryMerge(files []string, out string) error {
	return safely(func() error {
		return api.MergeCreateFile(context.Background(), files, out, false, mergeConf())
	})
}

// unlock entfernt einen bloßen Kopier-/Druckschutz (PDF öffnet sich ohne Passwort).
// Echte Öffnungs-Passwörter lassen sich nicht entfernen -> Datei bleibt, wie sie ist.
func unlock(f string) {
	tmp := f + ".offen"
	err := safely(func() error {
		return api.DecryptFile(context.Background(), f, tmp, mergeConf())
	})
	if err == nil && fileExists(tmp) {
		os.Rename(tmp, f)
		logf("Kopierschutz entfernt: %s", filepath.Base(f))
	} else {
		os.Remove(tmp)
	}
}

// mergePDFs fügt files zu out zusammen. files[0] (die E-Mail) kommt immer hinein.
// Liefert die Indizes der Dateien, die sich nicht anhängen ließen.
func mergePDFs(files []string, out string) (skipped []int) {
	if len(files) == 1 {
		if err := copyFile(files[0], out); err != nil {
			logf("Kopieren fehlgeschlagen: %v", err)
		}
		return nil
	}
	for _, f := range files[1:] {
		unlock(f)
	}
	if err := tryMerge(files, out); err == nil {
		return nil
	} else {
		logf("Zusammenfügen fehlgeschlagen (%v) – prüfe Anlagen einzeln", err)
	}
	// Einzeln prüfen, welche Anlage Probleme macht
	good := []string{files[0]}
	test := filepath.Join(filepath.Dir(out), "test.pdf")
	for i, f := range files[1:] {
		if err := tryMerge([]string{files[0], f}, test); err == nil {
			good = append(good, f)
		} else {
			logf("Anlage %s nicht anfügbar: %v", filepath.Base(f), err)
			skipped = append(skipped, i+1)
		}
		os.Remove(test)
	}
	if len(good) == 1 || tryMerge(good, out) != nil {
		copyFile(files[0], out)
		skipped = skipped[:0]
		for i := 1; i < len(files); i++ {
			skipped = append(skipped, i)
		}
	}
	return skipped
}
