package main

// Name und Slogan an einer Stelle (Farben und Schrift: branding.go).
const (
	brandName    = "ERGOFORYOU"
	brandProduct = "Datei-Explorer"
	brandSlogan  = "Alles an seinem Platz."
)

// Version, die oben im Fenster und in Chrome angezeigt wird. appStage = "Testversion", solange wir
// ausprobieren – für die endgültige Fassung auf "" setzen (dann steht dort „freigegeben“).
const (
	appVersion = "0.9.0"
	appStage   = "Testversion"
)

// versionText: z. B. „Version 0.9.0 · Testversion · Stand 16.10.2026 09:30“.
func versionText() string {
	t := "Version " + appVersion
	if appStage != "" {
		t += " · " + appStage
	} else {
		t += " · freigegeben"
	}
	if len(buildVersion) == 14 { // JJJJMMTThhmmss
		b := buildVersion
		t += " · Stand " + b[6:8] + "." + b[4:6] + "." + b[0:4] + " " + b[8:10] + ":" + b[10:12]
	}
	return t
}
