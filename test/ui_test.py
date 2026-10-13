"""Loads the built extension in Chromium and runs one full signing flow."""
import sys, os, subprocess, tempfile
from playwright.sync_api import sync_playwright

dist = os.path.abspath(sys.argv[1])
pdf_in = os.path.abspath(sys.argv[2])
out = os.path.abspath(sys.argv[3])

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), channel="chromium", headless=True, accept_downloads=True,
        viewport={"width": 1280, "height": 860},
        args=[f"--disable-extensions-except={dist}", f"--load-extension={dist}"],
    )
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"chrome-extension://{ext_id}/app.html")
    page.wait_for_timeout(500)

    # draw a signature
    page.click("#drawBtn")
    box = page.locator("#pad").bounding_box()
    import math
    page.mouse.move(box["x"] + 60, box["y"] + box["height"] * 0.6)
    page.mouse.down()
    for i in range(80):
        t = i / 79
        page.mouse.move(box["x"] + 60 + t * box["width"] * 0.7,
                        box["y"] + box["height"] * (0.6 - 0.25 * math.sin(t * math.pi * 5)), steps=2)
    page.mouse.up()
    page.click("#padSave")

    # digital ID
    page.fill("#idName", "Mireneye Test")
    page.fill("#idEmail", "test@example.com")
    page.click("#idCreate")
    page.wait_for_selector("#backupDialog[open]", timeout=15000)
    page.fill("#bkPw", "lamp orbit cello mint"); page.fill("#bkPw2", "lamp orbit cello mint")
    with page.expect_download(): page.click("#bkSave")
    page.click("#bkDone")
    page.wait_for_selector("#idSome:not([hidden])", timeout=15000)

    # open the PDF and place on page 2 (rotated 90)
    page.set_input_files("#fileInput", pdf_in)
    page.wait_for_selector(".page canvas", timeout=15000)
    page.click("#placeBtn")
    pg = page.locator(".page").nth(1)
    pg.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    b = pg.bounding_box()
    page.mouse.click(b["x"] + b["width"] * 0.3, b["y"] + b["height"] * 0.2)
    page.wait_for_timeout(300)
    page.screenshot(path=f"{out}/ui.png")

    with page.expect_download() as dl:
        page.click("#downloadBtn")
    d = dl.value
    d.save_as(f"{out}/ui-signed.pdf")
    print("download name:", d.suggested_filename)

    # reload: signature and ID persist
    page.reload(); page.wait_for_timeout(800)
    print("sig persisted:", page.locator("#sigEmpty").is_hidden(), "| id persisted:", page.locator("#idSome").is_visible())
    print("errors:", errors or "none")
    ctx.close()
