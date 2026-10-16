package main

// Native Messaging: Chrome startet DateiExplorer.exe als Hilfsprogramm, wenn die Erweiterung
// den Explorer öffnet. Das Hilfsprogramm sorgt dafür, dass das eigentliche Programm im
// Hintergrund läuft, und öffnet Dateien so, dass ihr Fenster vorne erscheint.

import (
	"embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

//go:embed chrome
var chromeExtension embed.FS

// isNativeHostCall: Chrome übergibt die Herkunft der Erweiterung als Argument.
func isNativeHostCall(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			return true
		}
	}
	return false
}

func readNativeMessage(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n > 1<<20 {
		return nil, errors.New("Nachricht zu groß")
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return b, err
}

func writeNativeMessage(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func runNativeHost() {
	msg, err := readNativeMessage(os.Stdin)
	if err != nil {
		return
	}
	var req struct {
		Cmd   string
		Paths []string
		Path  string
	}
	json.Unmarshal(msg, &req)
	resp := map[string]any{"ok": true, "version": buildVersion}
	switch req.Cmd {
	case "start":
		port, err := ensureAppRunning()
		resp["port"] = port
		if err != nil {
			resp["ok"] = false
			resp["error"] = err.Error()
		}
	case "open":
		var errs []string
		for _, p := range req.Paths {
			if _, err := os.Stat(p); err != nil {
				errs = append(errs, "Nicht mehr vorhanden oder kein Zugriff: "+p)
				continue
			}
			if err := hostOpen(p); err != nil {
				errs = append(errs, err.Error())
			}
		}
		if len(errs) > 0 {
			resp["ok"] = false
			resp["error"] = strings.Join(errs, "\n")
		}
	case "reveal":
		hostReveal(req.Path)
	case "foreground":
		// das Programm darf gleich sein Fenster (Einstellungen) nach vorne holen
		allowAppForeground()
	}
	writeNativeMessage(os.Stdout, resp)
}

func pingPort(p int) bool {
	if p == 0 {
		return false
	}
	c := http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/ping", p))
	if err != nil {
		return false
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(r.Body, 100))
	return strings.HasPrefix(string(b), pingName)
}

// ensureAppRunning startet das Programm im Hintergrund, falls es nicht schon läuft.
func ensureAppRunning() (int, error) {
	if p := readWebPort(); pingPort(p) {
		return p, nil
	}
	if err := startAppBackground(); err != nil {
		return 0, fmt.Errorf("Programm konnte nicht gestartet werden: %v", err)
	}
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		if p := readWebPort(); pingPort(p) {
			return p, nil
		}
	}
	return 0, errors.New("Programm startet nicht – bitte DateiExplorer.exe einmal von Hand starten")
}

func nativeHostManifest(exe string) []byte {
	m := map[string]any{
		"name":            nativeHostName,
		"description":     brandName + " " + brandProduct,
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + extensionID + "/"},
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return b
}

// extensionDir: Ordner, aus dem Chrome die Erweiterung lädt.
func extensionDir() string {
	if portableMode() {
		return filepath.Join(portableDataDir(), "Chrome-Erweiterung")
	}
	if runtime.GOOS != "windows" {
		// ohne Windows: neben den Einstellungen
		return filepath.Join(filepath.Dir(userConfigPath()), "Chrome-Erweiterung")
	}
	return filepath.Join(filepath.Dir(indexPath()), "Chrome-Erweiterung")
}

// writeExtension legt die Erweiterung (aus der EXE) in extensionDir ab – bei jedem Start,
// damit Chrome nach einem Programm-Update automatisch die passende Oberfläche hat.
func writeExtension() (string, error) {
	dir := extensionDir()
	err := fs.WalkDir(chromeExtension, "chrome", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, "chrome"), "/")
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := chromeExtension.ReadFile(p)
		if err != nil {
			return err
		}
		if old, err := os.ReadFile(dst); err == nil && string(old) == string(data) {
			return nil
		}
		return os.WriteFile(dst, data, 0o644)
	})
	return dir, err
}

// extensionVersion: Version aus manifest.json der eingebauten Erweiterung.
func extensionVersion() string {
	b, _ := chromeExtension.ReadFile("chrome/manifest.json")
	var m struct{ Version string }
	json.Unmarshal(b, &m)
	return m.Version
}
