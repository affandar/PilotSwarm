import { describe, it } from "vitest";
import { getTheme, listThemes } from "../../../ui-core/src/themes/index.js";
import { assertEqual, assertIncludes, assertNotNull } from "../helpers/assertions.js";

describe("theme registry hacker x additions", () => {
    it("registers the new Hacker X themes for the shared picker", () => {
        const orionPrimeTheme = getTheme("hacker-x-orion-prime");
        const matrixTheme = getTheme("hacker-x-matrix");
        const themeIds = listThemes().map((theme) => theme.id);

        assertNotNull(orionPrimeTheme, "orion prime theme should be registered");
        assertNotNull(matrixTheme, "matrix theme should be registered");
        assertIncludes(themeIds.join(","), "hacker-x-orion-prime", "theme list should include Orion Prime");
        assertIncludes(themeIds.join(","), "hacker-x-matrix", "theme list should include Matrix");
        assertEqual(orionPrimeTheme.label, "Hacker X - Orion Prime", "orion prime label should match");
        assertEqual(matrixTheme.label, "Hacker X - Matrix", "matrix label should match");
    });
});
