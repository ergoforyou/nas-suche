//go:build !windows

package main

// NAS-Freigaben auf dem Mac: smb://-Adressen verbinden, den tatsächlichen Ort unter /Volumes
// finden und verständlich melden, warum ein Ordner nicht gelesen werden kann.

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"fyne.io/fyne/v2/dialog"
)

// smbURL wandelt \\Server\Freigabe, //Server/Freigabe, Server/Freigabe oder smb://Server/Freigabe
// in die Adresse der Freigabe (ohne Unterordner): smb://Server/Freigabe.
func smbURL(remote string) string {
	u, _ := splitSMB(remote)
	return u
}

// splitSMB trennt eine Netzwerkadresse in die Freigabe-Adresse und den Unterordner darin.
func splitSMB(remote string) (shareURL, sub string) {
	r := strings.TrimSpace(strings.ReplaceAll(remote, `\`, "/"))
	low := strings.ToLower(r)
	for _, p := range []string{"smb://", "cifs://", "afp://"} {
		if strings.HasPrefix(low, p) {
			r = r[len(p):]
			break
		}
	}
	r = strings.Trim(r, "/")
	if r == "" {
		return "", ""
	}
	if i := strings.Index(r, "@"); i >= 0 && i < strings.Index(r+"/", "/") {
		r = r[i+1:] // Benutzername nicht speichern – das Kennwort liegt im Schlüsselbund
	}
	parts := strings.Split(r, "/")
	host := parts[0]
	if len(parts) == 1 {
		return "smb://" + host, ""
	}
	share := unescape(parts[1])
	return "smb://" + host + "/" + (&url.URL{Path: share}).EscapedPath(), unescapePath(strings.Join(parts[2:], "/"))
}

func unescape(s string) string {
	if u, err := url.PathUnescape(s); err == nil {
		return u
	}
	return s
}

func unescapePath(s string) string {
	parts := strings.Split(s, "/")
	for i := range parts {
		parts[i] = unescape(parts[i])
	}
	return strings.Join(parts, "/")
}

// shareName liefert den Namen der Freigabe („Daten“) aus smb://Server/Daten.
func shareName(u string) string {
	r := strings.TrimPrefix(u, "smb://")
	if i := strings.Index(r, "/"); i >= 0 {
		return unescape(r[i+1:])
	}
	return ""
}

func isNetworkPath(p string) bool {
	low := strings.ToLower(strings.TrimSpace(p))
	return strings.HasPrefix(low, "smb://") || strings.HasPrefix(low, "cifs://") || strings.HasPrefix(low, "afp://") ||
		strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//")
}

var mountLine = regexp.MustCompile(`^//(?:[^@]*@)?([^/ ]+)/(.+?) on (/.+?) \((smbfs|afpfs|nfs|webdav)`)

// smbMounts: Freigabename (klein) → Ort unter /Volumes, laut `mount`.
func smbMounts() map[string]string {
	out, err := exec.Command("/sbin/mount").Output()
	if err != nil {
		return nil
	}
	m := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		if g := mountLine.FindStringSubmatch(l); g != nil {
			m[strings.ToLower(unescape(g[2]))] = g[3]
		}
	}
	return m
}

// mountPoint: wo die Freigabe eingehängt ist ("" = nicht verbunden).
func mountPoint(shareURL string) string {
	return smbMounts()[strings.ToLower(shareName(shareURL))]
}

// normalizeFolders macht aus eingetippten Netzwerkadressen (smb://…, \\Server\…) Freigaben,
// die beim Start verbunden werden, und als Suchordner den Ort unter /Volumes.
func (a *MacApp) normalizeFolders() bool {
	c := a.cfg
	changed := false
	for i, f := range c.Folders {
		if !isNetworkPath(f) {
			continue
		}
		u, sub := splitSMB(f)
		if shareName(u) == "" {
			continue
		}
		a.addShare(u)
		local := mountPoint(u)
		if local == "" {
			local = filepath.Join("/Volumes", shareName(u))
		}
		c.Folders[i] = filepath.Join(local, sub)
		changed = true
	}
	for i, d := range c.Drives {
		if u := smbURL(d.Remote); u != d.Remote {
			c.Drives[i].Remote = u
			changed = true
		}
	}
	return changed
}

func (a *MacApp) addShare(u string) {
	for _, d := range a.cfg.Drives {
		if strings.EqualFold(smbURL(d.Remote), u) {
			return
		}
	}
	a.cfg.Drives = append(a.cfg.Drives, DriveMap{Remote: u})
}

// mountShares verbindet die eingetragenen Freigaben (macOS fragt einmal nach dem Kennwort
// und bietet an, es im Schlüsselbund zu sichern) und liefert verständliche Fehlermeldungen.
func (a *MacApp) mountShares() (problems []string) {
	if runtime.GOOS != "darwin" {
		return nil
	}
	for _, d := range a.cfg.Drives {
		u := smbURL(d.Remote)
		if u == "" {
			continue
		}
		if shareName(u) == "" {
			problems = append(problems, fmt.Sprintf("„%s“: Bitte auch den Namen der Freigabe angeben, z. B. %s/Daten", u, u))
			continue
		}
		if mountPoint(u) != "" {
			continue
		}
		a.setStatus("Verbinde " + u + " …")
		out, err := exec.Command("osascript", "-e", `mount volume "`+u+`"`).CombinedOutput()
		if err != nil {
			problems = append(problems, fmt.Sprintf("„%s“ konnte nicht verbunden werden: %s", u, mountError(string(out))))
			continue
		}
		a.fixMovedVolume(u)
	}
	return problems
}

// fixMovedVolume: hängt macOS die Freigabe z. B. als /Volumes/Daten-1 ein, werden die Suchordner angepasst.
func (a *MacApp) fixMovedVolume(u string) {
	mp := mountPoint(u)
	want := filepath.Join("/Volumes", shareName(u))
	if mp == "" || mp == want {
		return
	}
	for i, f := range a.cfg.Folders {
		if f == want || strings.HasPrefix(f, want+"/") {
			if _, err := os.Stat(f); err != nil {
				a.cfg.Folders[i] = mp + strings.TrimPrefix(f, want)
			}
		}
	}
	a.cfg.Save()
}

func mountError(out string) string {
	out = strings.TrimSpace(out)
	switch {
	case strings.Contains(out, "(-128)"):
		return "Anmeldung abgebrochen."
	case strings.Contains(out, "(-43)") || strings.Contains(out, "(-35)"):
		return "Freigabe nicht gefunden – Name der Freigabe prüfen (Groß-/Kleinschreibung, z. B. „Daten“ statt „daten“)."
	case strings.Contains(out, "(-5014)") || strings.Contains(out, "(-6602)") || strings.Contains(out, "(-36)") ||
		strings.Contains(out, "(-5000)") || strings.Contains(out, "(-1700)"):
		return "Server nicht erreichbar oder Zugang verweigert – ist der Mac im Firmennetz/VPN? " +
			"Statt des Namens die IP-Adresse probieren (z. B. smb://192.168.1.10/Daten). (" + out + ")"
	case out == "":
		return "unbekannter Fehler."
	}
	return out
}

// checkFolders prüft, ob die Suchordner lesbar sind, und erklärt, was zu tun ist.
func checkFolders(folders []string) (problems []string, okCount int) {
	for _, f := range folders {
		_, err := os.ReadDir(f)
		switch {
		case err == nil:
			okCount++
		case errors.Is(err, fs.ErrNotExist):
			hint := ""
			if strings.HasPrefix(f, "/Volumes/") {
				hint = " Die NAS-Freigabe ist nicht verbunden.\n→ Ist sie unter „Einstellungen → NAS-Freigaben“ eingetragen (z. B. smb://DiskStation/Daten)?\n→ Test: im Finder ⌘K drücken und dieselbe Adresse verbinden – klappt das, findet die Suche sie auch."
			}
			problems = append(problems, fmt.Sprintf("Ordner „%s“ gibt es nicht.%s", f, hint))
		case errors.Is(err, fs.ErrPermission) || strings.Contains(err.Error(), "not permitted"):
			problems = append(problems, fmt.Sprintf("macOS verweigert den Zugriff auf „%s“.\n"+
				"→ Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner → „%s %s“ → "+
				"„Netzwerkvolumes“ einschalten (bzw. „Festplattenvollzugriff“). Danach das Programm neu starten.",
				f, brandName, brandProduct))
		default:
			problems = append(problems, fmt.Sprintf("Ordner „%s“ nicht lesbar: %v", f, err))
		}
	}
	return
}

// connectAndCheck: Netzwerkadressen umwandeln, Freigaben verbinden, Suchordner prüfen.
// report=true meldet auch Erfolg (nach dem Speichern der Einstellungen).
func (a *MacApp) connectAndCheck(report bool) bool {
	if a.normalizeFolders() {
		a.cfg.Save()
	}
	problems := a.mountShares()
	p2, ok := checkFolders(a.cfg.Folders)
	problems = append(problems, p2...)
	if len(problems) > 0 {
		a.setStatus("Problem mit der NAS-Verbindung – siehe Hinweis.")
		dialog.ShowInformation("Verbindung zum NAS", strings.Join(problems, "\n\n"), a.w)
	} else if report && len(a.cfg.Folders) > 0 {
		dialog.ShowInformation("Verbindung zum NAS",
			fmt.Sprintf("Alles in Ordnung – %d Suchordner erreichbar:\n%s", ok, strings.Join(a.cfg.Folders, "\n")), a.w)
	}
	return len(problems) == 0
}

// chooseFolder öffnet den Ordner-Auswahldialog des Mac (zeigt auch verbundene NAS-Freigaben).
func chooseFolder(prompt string) (string, bool) {
	if runtime.GOOS != "darwin" {
		return "", false
	}
	out, err := exec.Command("osascript", "-e",
		`POSIX path of (choose folder with prompt "`+prompt+`" default location (POSIX file "/Volumes"))`).Output()
	if err != nil {
		return "", true // abgebrochen
	}
	p := strings.TrimSpace(string(out))
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return p, true
}
