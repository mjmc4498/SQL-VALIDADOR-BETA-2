import asyncio
from playwright.async_api import async_playwright, expect
import os

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        # Get the absolute path to the HTML file
        file_path = os.path.abspath('index.html')

        # Go to the local HTML file
        await page.goto(f'file://{file_path}')

        # --- Test BigQuery (Default) ---
        await expect(page.locator("#projectLabel")).to_have_text("Proyecto (GCP)")
        await expect(page.locator("#datasetLabel")).to_have_text("Dataset / Schema")

        # Fill in some data for BigQuery
        await page.locator("#project").fill("gcp-project")
        await page.locator("#dataset").fill("my_dataset")
        await page.locator("#tableSource").fill("source_table")
        await page.locator('input[data-key="count"]').check()

        await page.get_by_role("button", name="Generar SQL Avanzado").click()
        await expect(page.locator("#sqlArea")).to_contain_text("Validaciones generadas para: BIGQUERY")
        await expect(page.locator("#sqlArea")).to_contain_text("`gcp-project.my_dataset.source_table`")

        # --- Test PostgreSQL ---
        await page.locator("#dbEngine").select_option("postgres")
        await expect(page.locator("#projectLabel")).to_have_text("Base de Datos")
        await expect(page.locator("#datasetLabel")).to_have_text("Schema (opcional)")

        await page.locator("#project").fill("postgres-db")
        await page.locator("#dataset").fill("public")
        await page.locator("#tableSource").fill("pg_table")

        await page.get_by_role("button", name="Generar SQL Avanzado").click()
        await expect(page.locator("#sqlArea")).to_contain_text("Validaciones generadas para: POSTGRES")
        await expect(page.locator("#sqlArea")).to_contain_text('"public"."pg_table"')

        # --- Test MongoDB ---
        await page.locator("#dbEngine").select_option("mongodb")
        await expect(page.locator("#projectLabel")).to_have_text("Base de Datos")
        await expect(page.locator("#datasetLabel")).to_have_text("Colección")

        await page.locator("#project").fill("mongo-db")
        await page.locator("#dataset").fill("users") # In Mongo, dataset is the collection
        await page.locator("#tableSource").fill("users")

        await page.get_by_role("button", name="Generar SQL Avanzado").click()
        await expect(page.locator("#sqlArea")).to_contain_text("Validaciones generadas para: MONGODB")
        await expect(page.locator("#sqlArea")).to_contain_text("db.getCollection('users').countDocuments({});")

        # --- Test Diff validation on MySQL ---
        await page.locator("#dbEngine").select_option("mysql")
        await page.locator("#tableDest").fill("dest_table")
        await page.locator("#fields").fill("id, name, email")
        await page.locator('input[data-key="diff"]').check()
        await page.get_by_role("button", name="Generar SQL Avanzado").click()
        await expect(page.locator("#sqlArea")).to_contain_text("s.`id` = d.`id` AND s.`name` = d.`name` AND s.`email` = d.`email`")

        # --- Test Diff validation on MongoDB ---
        await page.locator("#dbEngine").select_option("mongodb")
        await page.get_by_role("button", name="Generar SQL Avanzado").click()

        # Take a screenshot of the final state (MongoDB diff selected)
        await page.screenshot(path="jules-scratch/verification/verification_diff.png")

        await browser.close()

asyncio.run(main())
