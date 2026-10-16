// EML zu PDF – wandelt E-Mails (.eml) samt Anlagen in PDF-Dateien um.
//
// Bedienung unter Windows:
//
//	EML-zu-PDF.exe doppelklicken        -> Installation (Rechtsklick-Menü, optional Automatik)
//	.eml markieren -> Rechtsklick       -> "In PDF umwandeln"
//
// Kommandozeile:
//
//	EML-zu-PDF.exe DATEI.eml [...]      Dateien umwandeln
//	EML-zu-PDF.exe --ueberwachen [ORDNER] [--alle]
//	                                    Ordner (Standard: Downloads) beobachten
//	EML-zu-PDF.exe --installieren | --deinstallieren
//
// Weitere Optionen: --ziel ORDNER (Ausgabeordner), --still (keine Meldungsfenster)
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	appName = "EML zu PDF"
	exeName = "EML-zu-PDF.exe"
	version = "1.3.0"
)

var (
	dataDir string
	logger  *log.Logger
	quiet   bool
)

func logf(format string, args ...any) { logger.Printf(format, args...) }

func setupDataDir() {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		dataDir = filepath.Join(os.Getenv("LOCALAPPDATA"), appName)
	case "darwin":
		dataDir = filepath.Join(home, "Library", "Application Support", appName)
	default:
		dataDir = filepath.Join(home, ".eml2pdf")
	}
	os.MkdirAll(filepath.Join(dataDir, "warteschlange"), 0o755)
	var w io.Writer = io.Discard
	if f, err := os.OpenFile(filepath.Join(dataDir, "protokoll.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		w = f
	}
	if runtime.GOOS != "windows" {
		w = io.MultiWriter(w, os.Stderr)
	}
	logger = log.New(w, "", log.LstdFlags)
}

func main() {
	runtime.LockOSThread() // Windows-Mutex muss im selben Thread freigegeben werden
	setupDataDir()

	var files []string
	var outDir, watchDir string
	var watchMode, watchAll, install, uninstall, changeFolder bool
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "--ziel":
			if i+1 < len(args) {
				outDir = args[i+1]
				i++
			}
		case "--ueberwachen":
			watchMode = true
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				watchDir = args[i+1]
				i++
			}
		case "--alle":
			watchAll = true
		case "--still":
			quiet = true
		case "--installieren":
			install = true
		case "--deinstallieren":
			uninstall = true
		case "--zielordner":
			changeFolder = true
		default:
			if strings.HasPrefix(a, "-psn_") { // ältere macOS-Versionen hängen das beim Start an
				continue
			}
			files = append(files, a)
		}
	}

	watchOut := outDir // Überwachung liest die Einstellung bei jeder Mail neu
	if outDir == "" {
		outDir = loadSettings().Zielordner
	}

	switch {
	case changeFolder:
		if dir, ok := askOutputFolder(); ok {
			showInfo(appName, "Die PDFs werden ab jetzt hier gespeichert:\n\n"+dir)
		}
	case uninstall:
		uninstallApp()
	case install:
		installApp()
	case watchMode:
		if watchDir == "" {
			watchDir = downloadsFolder()
		}
		watch(watchDir, watchOut, watchAll)
	case len(files) > 0:
		os.Exit(convertBatch(files, outDir))
	default:
		if !isInstalledCopy() {
			installApp()
		} else {
			mainMenu(outDir)
		}
	}
}

// ---------------------------------------------------------------- Einstellungen

type settings struct {
	Zielordner string
}

func loadSettings() settings {
	var st settings
	raw, err := os.ReadFile(filepath.Join(dataDir, "einstellungen.json"))
	if err == nil {
		json.Unmarshal(raw, &st)
	}
	return st
}

func saveSettings(st settings) error {
	data, _ := json.MarshalIndent(st, "", "  ")
	return os.WriteFile(filepath.Join(dataDir, "einstellungen.json"), data, 0o644)
}

// askOutputFolder lässt den Zielordner auswählen (oder neu anlegen) und speichert ihn.
func askOutputFolder() (string, bool) {
	current := loadSettings().Zielordner
	if current == "" {
		current = filepath.Join(downloadsFolder(), "E-Mails als PDF")
	}
	os.MkdirAll(current, 0o755) // Vorschlag anlegen, damit er im Dialog auswählbar ist
	dir, ok := chooseFolder("Ordner für die fertigen PDFs auswählen (oder mit „Neuen Ordner erstellen“ anlegen):", current)
	if !ok {
		dir = current
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		showWarning(appName, "Der Ordner kann nicht verwendet werden:\n"+err.Error())
		return "", false
	}
	if dir != current {
		os.Remove(current) // nicht genutzten Vorschlag wieder entfernen (nur wenn leer)
	}
	if err := saveSettings(settings{Zielordner: dir}); err != nil {
		showWarning(appName, "Einstellung konnte nicht gespeichert werden:\n"+err.Error())
		return "", false
	}
	return dir, true
}

// ---------------------------------------------------------------- Umwandeln (Rechtsklick)

// convertBatch sammelt die Dateien aller gleichzeitig gestarteten Aufrufe
// (Windows startet bei Mehrfachauswahl das Programm einmal pro Datei)
// und wandelt sie gemeinsam um – mit nur einer Abschlussmeldung.
func convertBatch(files []string, outDir string) int {
	queue := filepath.Join(dataDir, "warteschlange")
	var abs []string
	for _, f := range files {
		if a, err := filepath.Abs(f); err == nil {
			abs = append(abs, a)
		}
	}
	job := struct {
		Files  []string
		OutDir string
	}{abs, outDir}
	data, _ := json.Marshal(job)
	own := filepath.Join(queue, fmt.Sprintf("%d-%d.json", time.Now().UnixNano(), os.Getpid()))
	os.WriteFile(own+".tmp", data, 0o644)
	os.Rename(own+".tmp", own)

	release := acquireWorkerLock()
	defer release()
	if !fileExists(own) {
		return 0 // ein anderer Aufruf hat die Datei schon mit erledigt
	}
	time.Sleep(700 * time.Millisecond) // auf weitere gleichzeitige Aufrufe warten

	var created, errs []string
	mails := 0
	folders := map[string]bool{}
	for idle := 0; idle < 2; {
		jobs, _ := filepath.Glob(filepath.Join(queue, "*.json"))
		sort.Strings(jobs)
		if len(jobs) == 0 {
			idle++
			time.Sleep(400 * time.Millisecond)
			continue
		}
		idle = 0
		for _, j := range jobs {
			raw, err := os.ReadFile(j)
			os.Remove(j)
			if err != nil || json.Unmarshal(raw, &job) != nil {
				continue
			}
			for _, f := range job.Files {
				out, warn, err := ConvertEML(f, job.OutDir)
				created = append(created, out...)
				for _, w := range warn {
					errs = append(errs, filepath.Base(f)+": "+w)
				}
				if err != nil {
					logf("Fehler bei %s: %v", f, err)
					errs = append(errs, filepath.Base(f)+": "+err.Error())
					continue
				}
				mails++
				if len(out) > 0 {
					folders[filepath.Dir(out[0])] = true
				}
			}
		}
	}

	if !quiet {
		var msg strings.Builder
		fmt.Fprintf(&msg, "%d E-Mail(s) umgewandelt – je eine PDF-Datei mit allen Anlagen.", mails)
		folder := ""
		if len(folders) == 1 {
			for f := range folders {
				folder = f
				fmt.Fprintf(&msg, "\n\nGespeichert in:\n%s", f)
			}
		}
		if len(errs) > 0 {
			msg.WriteString("\n\nBitte prüfen:\n" + strings.Join(errs, "\n"))
		}
		showResult(appName, msg.String(), folder, len(errs) > 0)
	}
	if len(errs) > 0 {
		return 1
	}
	return 0
}

// ---------------------------------------------------------------- Ordner überwachen

func watch(folder, outDir string, includeExisting bool) {
	if !tryWatcherLock() {
		logf("Überwachung läuft bereits")
		return
	}
	logf("Überwache %s", folder)
	stateFile := filepath.Join(dataDir, "erledigt.json")
	state := map[string]string{}
	raw, err := os.ReadFile(stateFile)
	firstRun := err != nil
	json.Unmarshal(raw, &state)
	save := func() {
		data, _ := json.MarshalIndent(state, "", " ")
		os.WriteFile(stateFile, data, 0o644)
	}
	fingerprint := func(st os.FileInfo) string {
		return fmt.Sprintf("%d:%d", st.Size(), st.ModTime().Unix())
	}
	list := func() []string {
		all, _ := filepath.Glob(filepath.Join(folder, "*"))
		var out []string
		for _, p := range all {
			if strings.EqualFold(filepath.Ext(p), ".eml") {
				out = append(out, p)
			}
		}
		return out
	}
	if firstRun && !includeExisting {
		for _, p := range list() {
			if st, err := os.Stat(p); err == nil {
				state[p] = fingerprint(st)
			}
		}
		save()
	}

	sizes := map[string]int64{}
	for {
		for _, p := range list() {
			st, err := os.Stat(p)
			if err != nil || state[p] == fingerprint(st) {
				continue
			}
			// Warten, bis der Download fertig ist (Größe zweimal gleich)
			if prev, ok := sizes[p]; !ok || prev != st.Size() || st.Size() == 0 {
				sizes[p] = st.Size()
				continue
			}
			delete(sizes, p)
			target := outDir
			if target == "" {
				target = loadSettings().Zielordner
			}
			if _, _, err := ConvertEML(p, target); err != nil {
				logf("Fehler bei %s: %v", p, err)
			}
			state[p] = fingerprint(st)
			save()
		}
		time.Sleep(3 * time.Second)
	}
}
