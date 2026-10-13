"""Two people, two browsers: Alice requests Bob's signature, Bob signs in his box."""
import sys, os, tempfile, math
from playwright.sync_api import sync_playwright

dist, pdf_in, out = map(os.path.abspath, sys.argv[1:4])

def browser(p):
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel="chromium", headless=True, accept_downloads=True,
        viewport={"width": 1280, "height": 900}, args=[f"--disable-extensions-except={dist}", f"--load-extension={dist}"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    page = ctx.new_page(); errs = []
    page.on("console", lambda m: m.type == "error" and errs.append(m.text))
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"chrome-extension://{sw.url.split('/')[2]}/app.html"); page.wait_for_timeout(400)
    return ctx, page, errs

def draw(page):
    box = page.locator("#pad").bounding_box()
    page.mouse.move(box["x"] + 80, box["y"] + box["height"] * 0.6); page.mouse.down()
    for i in range(60):
        t = i / 59
        page.mouse.move(box["x"] + 80 + t * box["width"] * 0.6, box["y"] + box["height"] * (0.6 - 0.2 * math.sin(t * 9)), steps=3)
    page.mouse.up(); page.click("#padSave")

def make_id(page, name, pw):
    page.fill("#idName", name); page.click("#idCreate")
    page.wait_for_selector("#backupDialog[open]", timeout=15000)
    page.fill("#bkPw", pw); page.fill("#bkPw2", pw)
    with page.expect_download(): page.click("#bkSave")
    page.click("#bkDone")

with sync_playwright() as p:
    # Alice: requests Bob, no own signature
    ctx, a, errs_a = browser(p)
    make_id(a, "Alice", "lamp orbit cello mint")
    a.set_input_files("#fileInput", pdf_in); a.wait_for_selector(".page canvas")
    a.fill("#reqName", "Bob Example"); a.click("#reqAdd")
    b0 = a.locator(".page").first.bounding_box()
    a.mouse.click(b0["x"] + b0["width"] * 0.5, b0["y"] + b0["height"] * 0.75); a.wait_for_timeout(200)
    a.screenshot(path=f"{out}/req-alice.png")
    with a.expect_download() as dl: a.click("#downloadBtn")
    dl.value.save_as(f"{out}/req-for-bob.pdf")
    a.wait_for_selector("#shareDialog[open]")
    print("share text starts:", a.input_value("#shText").splitlines()[2])
    print("alice errors:", errs_a or "none"); ctx.close()

    # Bob: opens it, sees the box, signs
    ctx, b, errs_b = browser(p)
    make_id(b, "Bob Example", "river ten stone blue")
    b.set_input_files("#fileInput", f"{out}/req-for-bob.pdf"); b.wait_for_selector(".fieldbox button")
    print("todo:", b.text_content("#todoText"))
    b.click(".fieldbox button")
    b.wait_for_selector("#padDialog[open]"); draw(b)
    b.wait_for_timeout(300)
    print("after signing:", b.text_content("#todoText"))
    b.screenshot(path=f"{out}/req-bob.png")
    with b.expect_download() as dl: b.click("#downloadBtn")
    dl.value.save_as(f"{out}/req-signed-by-bob.pdf"); print("bob file:", dl.value.suggested_filename)
    print("bob errors:", errs_b or "none"); ctx.close()
