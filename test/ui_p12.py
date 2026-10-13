"""Backup + import flow in the built extension."""
import sys, os, tempfile
from playwright.sync_api import sync_playwright
dist, p12_in, out = map(os.path.abspath, sys.argv[1:4])
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel="chromium", headless=True, accept_downloads=True,
        viewport={"width": 1280, "height": 860}, args=[f"--disable-extensions-except={dist}", f"--load-extension={dist}"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    page = ctx.new_page(); errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"chrome-extension://{sw.url.split('/')[2]}/app.html"); page.wait_for_timeout(400)
    page.fill("#idName", "Åsa Test"); page.click("#idCreate")
    page.wait_for_selector("#backupDialog[open]", timeout=15000)
    page.fill("#bkPw", "short"); page.fill("#bkPw2", "short"); page.click("#bkSave")
    print("short pw error:", page.text_content("#bkError"))
    page.fill("#bkPw", "long enough pw"); page.fill("#bkPw2", "long enough pw")
    page.screenshot(path=f"{out}/backup1.png")
    with page.expect_download() as dl: page.click("#bkSave")
    dl.value.save_as(f"{out}/ui-backup.p12"); print("backup file:", dl.value.suggested_filename)
    page.screenshot(path=f"{out}/backup2.png")
    page.click("#bkDone"); page.wait_for_timeout(300)
    print("origin:", page.text_content("#idShowSource"))
    # replace with an imported ID: wrong password then right one
    page.click("#idReplace"); page.set_input_files("#imFile", p12_in)
    page.fill("#imPw", "nope"); page.click("#imGo"); page.wait_for_timeout(800)
    print("wrong pw:", page.text_content("#imError"))
    page.fill("#imPw", "pw1234"); page.click("#imGo"); page.wait_for_timeout(800)
    print("now:", page.text_content("#idShowName"), "|", page.text_content("#idShowSource"))
    print("errors:", errors or "none"); ctx.close()
