package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/teamwork/tnef"
	"golang.org/x/text/encoding/htmlindex"
)

// Part ist ein Einzelteil einer E-Mail (Text, Bild, Anlage ...).
type Part struct {
	ContentType string
	Disposition string
	Filename    string
	ContentID   string
	Charset     string
	Data        []byte
}

// Mail ist eine zerlegte E-Mail.
type Mail struct {
	Subject, From, To, Cc string
	Date                  time.Time
	HTML, Text            string
	Inline                map[string]Part // Content-ID -> Bild
	Attachments           []Part
}

var wordDecoder = &mime.WordDecoder{CharsetReader: charsetReader}

func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return nil, err
	}
	return enc.NewDecoder().Reader(input), nil
}

func decodeHeader(s string) string {
	if d, err := wordDecoder.DecodeHeader(s); err == nil {
		return d
	}
	return s
}

// toUTF8 wandelt Text aus dem angegebenen Zeichensatz in UTF-8 um.
func toUTF8(data []byte, charset string) string {
	if charset != "" && !strings.EqualFold(charset, "utf-8") && !strings.EqualFold(charset, "us-ascii") {
		if enc, err := htmlindex.Get(charset); err == nil {
			if out, err := enc.NewDecoder().Bytes(data); err == nil {
				return string(out)
			}
		}
	}
	if utf8.Valid(data) {
		return string(data)
	}
	enc, _ := htmlindex.Get("windows-1252")
	out, _ := enc.NewDecoder().Bytes(data)
	return string(out)
}

func decodeTransfer(r io.Reader, cte string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(cte)) {
	case "base64":
		// Fehlerhafte Zeichen (z. B. Leerzeichen) vorher entfernen
		raw, err := io.ReadAll(r)
		if err != nil {
			return nil, err
		}
		clean := bytes.Map(func(c rune) rune {
			if c == '+' || c == '/' || c == '=' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
				return c
			}
			return -1
		}, raw)
		clean = bytes.TrimRight(clean, "=")
		return base64.RawStdEncoding.DecodeString(string(clean))
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(r))
	default:
		return io.ReadAll(r)
	}
}

// ParseMail liest eine .eml-Datei.
func ParseMail(raw []byte) (*Mail, error) {
	msg, err := mail.ReadMessage(bufio.NewReader(bytes.NewReader(raw)))
	if err != nil {
		return nil, fmt.Errorf("keine gültige E-Mail: %w", err)
	}
	h := msg.Header
	m := &Mail{
		Subject: decodeHeader(h.Get("Subject")),
		From:    decodeHeader(h.Get("From")),
		To:      decodeHeader(h.Get("To")),
		Cc:      decodeHeader(h.Get("Cc")),
		Inline:  map[string]Part{},
	}
	if d, err := mail.ParseDate(h.Get("Date")); err == nil {
		m.Date = d.Local()
	}

	var parts []Part
	if err := walk(textproto.MIMEHeader(h), msg.Body, &parts, 0); err != nil && len(parts) == 0 {
		return nil, err
	}
	m.split(parts)
	return m, nil
}

// walk sammelt alle Einzelteile, ohne in angehängte E-Mails hineinzugehen.
func walk(h textproto.MIMEHeader, body io.Reader, out *[]Part, depth int) error {
	ctype, params, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil || ctype == "" {
		ctype, params = "text/plain", map[string]string{}
	}
	if strings.HasPrefix(ctype, "multipart/") && params["boundary"] != "" && depth < 20 {
		mr := multipart.NewReader(body, params["boundary"])
		for {
			p, err := mr.NextRawPart()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
			if err := walk(p.Header, p, out, depth+1); err != nil {
				return err
			}
		}
	}

	data, err := decodeTransfer(body, h.Get("Content-Transfer-Encoding"))
	if err != nil && len(data) == 0 {
		return nil // kaputtes Teil überspringen
	}
	p := Part{ContentType: ctype, Charset: params["charset"], Data: data}
	disp, dparams, _ := mime.ParseMediaType(h.Get("Content-Disposition"))
	p.Disposition = disp
	p.Filename = decodeHeader(firstNonEmpty(dparams["filename"], params["name"]))
	p.ContentID = strings.Trim(strings.TrimSpace(h.Get("Content-Id")), "<>")
	*out = append(*out, p)
	return nil
}

func (m *Mail) split(parts []Part) {
	for _, p := range parts {
		isAttachment := p.Disposition == "attachment" || p.Filename != ""
		isImage := strings.HasPrefix(p.ContentType, "image/")
		switch {
		case p.ContentType == "message/rfc822":
			m.Attachments = append(m.Attachments, p)
		case p.ContentType == "text/html" && !isAttachment && m.HTML == "":
			m.HTML = toUTF8(p.Data, p.Charset)
		case p.ContentType == "text/plain" && !isAttachment && m.Text == "":
			m.Text = toUTF8(p.Data, p.Charset)
		case isImage && p.ContentID != "" && p.Disposition != "attachment":
			m.Inline[p.ContentID] = p
		case isAttachment || !strings.HasPrefix(p.ContentType, "text/"):
			if isImage && p.ContentID != "" {
				m.Inline[p.ContentID] = p // Outlook markiert eingebettete Bilder manchmal als Anlage
			}
			m.Attachments = append(m.Attachments, p)
		}
	}
	m.expandWinmailDat()

	// Eingebettete Bilder, die im Text gar nicht vorkommen, als Anlage behandeln
	lower := strings.ToLower(m.HTML)
	for cid, p := range m.Inline {
		if !strings.Contains(lower, "cid:"+strings.ToLower(cid)) {
			delete(m.Inline, cid)
			if p.Disposition != "attachment" && p.Filename == "" {
				m.Attachments = append(m.Attachments, p)
			}
		}
	}
}

// expandWinmailDat packt Outlook-"winmail.dat"-Anlagen (TNEF) aus,
// in denen Outlook die eigentlichen Anlagen versteckt.
func (m *Mail) expandWinmailDat() {
	var out []Part
	for _, p := range m.Attachments {
		if p.ContentType != "application/ms-tnef" && !strings.EqualFold(p.Filename, "winmail.dat") {
			out = append(out, p)
			continue
		}
		data, err := decodeTNEF(p.Data)
		if err != nil {
			logf("winmail.dat nicht lesbar: %v", err)
			out = append(out, p)
			continue
		}
		if m.HTML == "" && len(data.BodyHTML) > 0 {
			m.HTML = toUTF8(data.BodyHTML, "")
		}
		if m.Text == "" && len(data.Body) > 0 {
			m.Text = toUTF8(data.Body, "")
		}
		for _, a := range data.Attachments {
			if len(a.Data) == 0 {
				continue
			}
			out = append(out, Part{
				ContentType: "application/octet-stream",
				Disposition: "attachment",
				Filename:    toUTF8([]byte(a.Title), ""),
				Data:        a.Data,
			})
		}
	}
	m.Attachments = out
}

func decodeTNEF(b []byte) (d *tnef.Data, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("beschädigt: %v", r)
		}
	}()
	return tnef.Decode(b)
}

// AttachmentName liefert einen sinnvollen Dateinamen für eine Anlage.
func AttachmentName(p Part, index int) string {
	if p.Filename != "" {
		return p.Filename
	}
	if p.ContentType == "message/rfc822" {
		subject := "Weitergeleitete E-Mail"
		if inner, err := mail.ReadMessage(bytes.NewReader(p.Data)); err == nil {
			if s := decodeHeader(inner.Header.Get("Subject")); s != "" {
				subject = s
			}
		}
		return subject + ".eml"
	}
	ext := map[string]string{"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif"}[p.ContentType]
	if ext == "" {
		if exts, _ := mime.ExtensionsByType(p.ContentType); len(exts) > 0 {
			ext = exts[0]
		} else {
			ext = ".bin"
		}
	}
	return fmt.Sprintf("Anlage %d%s", index, ext)
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}
