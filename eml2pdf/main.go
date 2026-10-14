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
	version = "1.1.0"
)

var (
	dataDir string
	logger  *log.Logger
	quiet   bool
)

func logf(format string, args ...any) { logger.Printf(format, args...) }

func setupDataDir() {
	if runtime.GOOS == "windows" {
		dataDir = filepath.Join(os.Getenv("LOCALAPPDATA"), appName)
	} else {
		home, _ := os.UserHomeDir()
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
	var watchMode, watchAll, install, uninstall bool
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
		default:
			files = append(files, a)
		}
	}

	switch {
	case uninstall:
		uninstallApp()
	case install:
		installApp()
	case watchMode:
		if watchDir == "" {
			watchDir = downloadsFolder()
		}
		watch(watchDir, outDir, watchAll)
	case len(files) > 0:
		os.Exit(convertBatch(files, outDir))
	default:
		if runtime.GOOS == "windows" && !isInstalledCopy() {
			installApp()
		} else {
			showInfo(appName+" "+version, "So geht's:\n\n.eml-Dateien im Explorer markieren → Rechtsklick → „In PDF umwandeln“.\n\n"+
				"(Windows 11: zuerst „Weitere Optionen anzeigen“ oder Umschalt + Rechtsklick)\n\n"+
				"Deinstallieren: Einstellungen → Apps → „"+appName+"“.")
		}
	}
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
				out, warn, err := ConvertEML(f, job.OutDir, "")
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
		fmt.Fprintf(&msg, "%d E-Mail(s) umgewandelt, %d Datei(en) erstellt.", mails, len(created))
		if len(folders) == 1 {
			for f := range folders {
				fmt.Fprintf(&msg, "\n\nGespeichert in:\n%s", f)
			}
		}
		if len(errs) > 0 {
			msg.WriteString("\n\nBitte prüfen:\n" + strings.Join(errs, "\n"))
			showWarning(appName, msg.String())
		} else {
			showInfo(appName, msg.String())
		}
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
			if _, _, err := ConvertEML(p, outDir, ""); err != nil {
				logf("Fehler bei %s: %v", p, err)
			}
			state[p] = fingerprint(st)
			save()
		}
		time.Sleep(3 * time.Second)
	}
}
