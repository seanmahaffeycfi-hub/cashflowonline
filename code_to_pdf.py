from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from pathlib import Path

files = ["app.js", "index.html", "style.css"]

# Use a fixed-width font for code readability
pdfmetrics.registerFont(TTFont("Courier", "cour.ttf"))

for filename in files:
    source_path = Path(filename)
    output_path = Path(filename).with_suffix(".pdf")
    text = source_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    c = canvas.Canvas(str(output_path), pagesize=letter)
    width, height = letter
    margin = 40
    line_height = 12
    y = height - margin
    c.setFont("Courier", 10)

    for line in lines:
        for chunk_start in range(0, len(line), 95):
            chunk = line[chunk_start:chunk_start + 95]
            if y < margin + line_height:
                c.showPage()
                c.setFont("Courier", 10)
                y = height - margin
            c.drawString(margin, y, chunk)
            y -= line_height
    c.save()
    print(f"Written {output_path}")
