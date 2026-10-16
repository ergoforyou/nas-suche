package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const appName = "DateiExplorer"

// nasSucheName: Ordner der NAS-Suche – deren Einstellungen und Index werden beim ersten Start übernommen.
const nasSucheName = "NasSuche"

const defaultHotkey = "Strg+Umschalt+E"

type Config struct {
	Folders      []string `json:"ordner"`
	Excludes     []string `json:"ausschluesse"`
	RefreshHours int      `json:"aktualisieren_alle_stunden"`
	Workers      int      `json:"parallele_zugriffe"`
	InPath       bool     `json:"im_pfad_suchen"`

	Drives         []DriveMap `json:"netzlaufwerke"`
	SharedIndexDir string     `json:"gemeinsamer_index_ordner"`
	SharedWriter   bool       `json:"gemeinsamen_index_erstellen"`
	Hotkey         string     `json:"tastenkombination"`
	CopyTargets    []string   `json:"kopierziele"`
	TrayHintShown  bool       `json:"hinweis_hintergrund_gezeigt"`
	Filter         uint8      `json:"filter_haken"`      // Suche: Bits 2 PDF, 4 Bilder, 8 Office, 16 Ordner; 0 = alles
	SortCol        int        `json:"sortierung_spalte"` // Suche: Spalte der Trefferliste
	SortDesc       bool       `json:"sortierung_absteigend"`
	SearchScope    int        `json:"suchbereich"` // 0 überall, 1 im linken Ordner, 2 im rechten Ordner
	Version        int        `json:"einstellungen_version"`
	Favorites      []Favorite `json:"ordner_favoriten"`
	StartFolder    string     `json:"startordner_links"`
	StartFolder2   string     `json:"startordner_rechts"`
	LastFolder     string     `json:"zuletzt_links"`
	LastFolder2    string     `json:"zuletzt_rechts"`
	SortColL       int        `json:"sortierung_links"` // Explorer-Ansichten: Spalte
	SortDescL      bool       `json:"sortierung_links_absteigend"`
	SortColR       int        `json:"sortierung_rechts"`
	SortDescR      bool       `json:"sortierung_rechts_absteigend"`
	HideNav        bool       `json:"navigation_ausgeblendet"` // Ordnerbäume beider Seiten aus
	ViewMode       [2]int     `json:"ansicht"`                 // je Seite: 0 Details, 1 mittelgroße, 2 große Symbole
	HideTree       [2]bool    `json:"ordnerbaum_aus"`          // je Seite
	Preview        [2]bool    `json:"vorschaufenster"`         // je Seite
	ShowHidden     bool       `json:"versteckte_anzeigen"`
	// Ansicht der Chrome-Oberfläche (Haken, Sortierung, Spalten …), von der Erweiterung verwaltet
	WebState json.RawMessage `json:"chrome_ansicht,omitempty"`
}

// Favorite: fester Ordner im Menü „★ Ordner“ (z. B. Digitale Eingänge).
type Favorite struct {
	Name string `json:"name"`
	Path string `json:"pfad"`
}

// DriveMap: Netzlaufwerk, das beim Programmstart verbunden wird.
type DriveMap struct {
	Letter string `json:"laufwerk"` // "Z:" oder leer
	Remote string `json:"pfad"`     // \\DiskStation\Daten
}

func (d DriveMap) String() string {
	if d.Letter == "" {
		return d.Remote
	}
	return d.Letter + "   →   " + d.Remote
}

const sharedIndexName = "NasSuche-Index.dat"

func (c *Config) sharedIndexPath() string {
	if c.SharedIndexDir == "" {
		return ""
	}
	return filepath.Join(c.SharedIndexDir, sharedIndexName)
}

// sharedReader: Index kommt vom NAS, dieser PC liest selbst nicht ein.
func (c *Config) sharedReader() bool { return c.SharedIndexDir != "" && !c.SharedWriter }

func (c *Config) addCopyTarget(dir string) {
	out := []string{dir}
	for _, t := range c.CopyTargets {
		if !strings.EqualFold(t, dir) && len(out) < 8 {
			out = append(out, t)
		}
	}
	c.CopyTargets = out
}

func defaultConfig() *Config {
	return &Config{
		Excludes: []string{"#recycle", "@eaDir", "#snapshot", "@Recycle", "$RECYCLE.BIN",
			"System Volume Information", ".DS_Store", "Thumbs.db", "desktop.ini",
			".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".AppleDouble"},
		RefreshHours: 4,
		Workers:      16,
		Hotkey:       defaultHotkey,
	}
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// ---------- Portabler Betrieb (USB-Stick) ----------

// isRemovable wird unter Windows gesetzt (Laufwerkstyp „Wechseldatenträger“).
var isRemovable = func(dir string) bool { return false }

var portableChecked, portable bool

// portableMode: Das Programm läuft vom USB-Stick oder neben der EXE liegt „portable.txt“.
// Dann liegen Einstellungen und Index im Ordner „DateiExplorer-Daten“ neben der EXE – nichts auf dem PC.
func portableMode() bool {
	if portableChecked {
		return portable
	}
	portableChecked = true
	dir := exeDir()
	_, err1 := os.Stat(filepath.Join(dir, "portable.txt"))
	_, err2 := os.Stat(filepath.Join(dir, "DateiExplorer.portable"))
	if err1 != nil && err2 != nil && !isRemovable(dir) {
		return false
	}
	// nur wenn neben der EXE geschrieben werden kann
	data := portableDataDir()
	if os.MkdirAll(data, 0o755) != nil {
		return false
	}
	probe := filepath.Join(data, ".schreibtest")
	if os.WriteFile(probe, []byte("x"), 0o644) != nil {
		return false
	}
	os.Remove(probe)
	portable = true
	return true
}

func portableDataDir() string { return filepath.Join(exeDir(), "DateiExplorer-Daten") }

// userConfigPath: persönliche Einstellungen (%APPDATA%\DateiExplorer\einstellungen.json, portabel neben der EXE).
func userConfigPath() string {
	if portableMode() {
		return filepath.Join(portableDataDir(), "einstellungen.json")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = exeDir()
	}
	return filepath.Join(dir, appName, "einstellungen.json")
}

// sharedConfigPath: optionale Vorgabe neben der EXE (z. B. auf dem NAS für alle Kollegen).
func sharedConfigPath() string {
	return filepath.Join(exeDir(), "DateiExplorer.json")
}

// sharedConfigPaths: wo eine Vorgabe für Kollegen liegen darf – auch eine NasSuche.json daneben zählt.
func sharedConfigPaths() []string {
	return []string{sharedConfigPath(), filepath.Join(exeDir(), "NasSuche.json")}
}

// nasSucheConfigPath / nasSucheIndexPath: Einstellungen und Index der NAS-Suche auf diesem PC.
func nasSucheConfigPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, nasSucheName, "einstellungen.json")
}

func nasSucheIndexPath() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, nasSucheName, "index.dat")
}

func indexPath() string {
	if portableMode() {
		return filepath.Join(portableDataDir(), "index.dat")
	}
	dir, err := os.UserCacheDir() // %LOCALAPPDATA%
	if err != nil {
		dir = exeDir()
	}
	return filepath.Join(dir, appName, "index.dat")
}

func readConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := defaultConfig()
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Workers < 1 {
		c.Workers = 16
	}
	if c.Version < 1 {
		c.Version = 1
	}
	return c, nil
}

// LoadConfig: erst persönliche Einstellungen, sonst Vorgabe neben der EXE, sonst die Einstellungen
// der NAS-Suche auf diesem PC (Suchordner, Netzlaufwerke, feste Ordner …), sonst Standard.
func LoadConfig() *Config {
	if c, err := readConfig(userConfigPath()); err == nil {
		return c
	}
	for _, p := range sharedConfigPaths() {
		if c, err := readConfig(p); err == nil {
			return fromNasSuche(c)
		}
	}
	if !portableMode() {
		if c, err := readConfig(nasSucheConfigPath()); err == nil {
			return fromNasSuche(c)
		}
	}
	return defaultConfig()
}

// fromNasSuche übernimmt nur das Gemeinsame: Ordner, Laufwerke, Index, feste Ordner, Kopierziele.
// Ansicht und Tastenkombination gehören dem Explorer selbst.
func fromNasSuche(src *Config) *Config {
	c := defaultConfig()
	c.Folders, c.Excludes, c.Drives = src.Folders, src.Excludes, src.Drives
	if src.RefreshHours > 0 {
		c.RefreshHours = src.RefreshHours
	}
	if src.Workers > 0 {
		c.Workers = src.Workers
	}
	// Den gemeinsamen Index liest der Explorer nur – erstellt wird er weiter von der NAS-Suche.
	c.SharedIndexDir = src.SharedIndexDir
	c.Favorites, c.CopyTargets = src.Favorites, src.CopyTargets
	c.StartFolder, c.StartFolder2 = src.StartFolder, src.StartFolder2
	c.InPath = src.InPath
	return c
}

func (c *Config) Save() error {
	p := userConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o644)
}
