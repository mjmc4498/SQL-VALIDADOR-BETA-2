
import os
from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch()
    page = browser.new_page()

    # Go to the local HTML file
    page.goto(f"file://{os.path.abspath('index.html')}")

    # Take a screenshot
    page.screenshot(path="jules-scratch/verification/verification_new_design.png")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)
