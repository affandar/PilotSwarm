/**
 * Some model-authored questions contain literal newline escapes. Decode those
 * for presentation before markdown parsing, including mixed real/escaped lines.
 * Keep stored question/choice identity intact for answers and history matching.
 * Code spans/fences, Windows paths, quoted escape literals and doubled slashes
 * are literal content, not formatting. Do not run a general JSON unescape here.
 */
export function normalizeQuestionForDisplay(value) {
    const source = String(value ?? "");
    if (!source.includes("\\n")) return source;
    const tokens = /(`+)[\s\S]*?\1(?!`)|(~{3,})[\s\S]*?\2|(["'])[A-Za-z]:\\[^\r\n]*?\3|(?<!\w)(?:[A-Za-z]:\\|\\\\)(?:(?!\\n\\n|\\r\\n\\r\\n)[^\s"'`])+|(["'])(?:\\r\\n|\\[nr])\4|\\\\|\\r\\n|\\n/g;
    return source.replace(tokens, token => token === "\\n" || token === "\\r\\n" ? "\n" : token);
}
