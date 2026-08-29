import assert from "node:assert/strict";
import test from "node:test";
import {
    LifecycleStateLoadError,
    RemoteLifecycleStateReader,
    lifecycleStateMarkdownPath,
    loadLifecycleStateMarkdown,
} from "../../dist/lifecycle-state-loader.js";

const workDetailsMarkdown = [
    "# Work details gathered",
    "",
    "Ask the user to confirm the diagnosis.",
].join("\r\n");
const diagnosedMarkdown = "# Diagnosed\n\nProduce the greeting.\n";
const fixProposedMarkdown = "# Fix proposed\n\nPrepare platform delivery.\n";
const prPublishedMarkdown = "# PR published\n\nTerminal platform state.\n";

function sources() {
    return [
        {
            sourceId: "hello-world-user",
            owner: "user",
            filePrefix: "HelloWorld",
            basePath: "lifecycles/hello-world",
            repository: "service-repo",
            requestedRef: "refs/heads/users/demo",
            resolvedCommit: "abc123",
        },
        {
            sourceId: "standard-fix-delivery@1",
            owner: "platform",
            filePrefix: "StandardFix",
            basePath: "profiles/standard-fix",
            version: "1",
            digest: "profile-digest",
        },
    ];
}

function inMemoryReader(files, reads = []) {
    return {
        async readStateMarkdown(source, sourcePath) {
            reads.push([source.sourceId, sourcePath]);
            return files.get(`${source.sourceId}:${sourcePath}`) ?? null;
        },
    };
}

function stateFiles() {
    return new Map([
        ["hello-world-user:lifecycles/hello-world/HelloWorld.WorkDetailsGathered.md", workDetailsMarkdown],
        ["hello-world-user:lifecycles/hello-world/HelloWorld.Diagnosed.md", diagnosedMarkdown],
        ["standard-fix-delivery@1:profiles/standard-fix/StandardFix.FixProposed.md", fixProposedMarkdown],
        ["standard-fix-delivery@1:profiles/standard-fix/StandardFix.PRPublished.md", prPublishedMarkdown],
    ]);
}

async function expectCode(promise, code) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof LifecycleStateLoadError);
        assert.equal(error.code, code);
        return true;
    });
}

test("loads the exact user-owned Markdown for the current state", async () => {
    const reads = [];
    const loaded = await loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "WorkDetailsGathered",
        sources: sources(),
        reader: inMemoryReader(stateFiles(), reads),
    });

    assert.equal(loaded.owner, "user");
    assert.equal(loaded.source.sourceId, "hello-world-user");
    assert.equal(loaded.sourcePath, "lifecycles/hello-world/HelloWorld.WorkDetailsGathered.md");
    assert.equal(loaded.markdown, workDetailsMarkdown, "CRLF and Markdown content must remain exact");
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(reads, [
        ["hello-world-user", "lifecycles/hello-world/HelloWorld.WorkDetailsGathered.md"],
        ["standard-fix-delivery@1", "profiles/standard-fix/StandardFix.WorkDetailsGathered.md"],
    ]);
});

test("loads platform Markdown without assembling or renaming it", async () => {
    const loaded = await loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "FixProposed",
        sources: [...sources()].reverse(),
        reader: inMemoryReader(stateFiles()),
    });

    assert.equal(loaded.owner, "platform");
    assert.equal(loaded.source.sourceId, "standard-fix-delivery@1");
    assert.equal(loaded.sourcePath, "profiles/standard-fix/StandardFix.FixProposed.md");
    assert.equal(loaded.markdown, fixProposedMarkdown);
    assert.equal("files" in loaded, false, "a combined lifecycle package must not be materialized");
});

test("worker activation probes only the requested state path in each source", async () => {
    const reads = [];
    await loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "PRPublished",
        sources: sources(),
        reader: inMemoryReader(stateFiles(), reads),
    });

    assert.deepEqual(reads, [
        ["hello-world-user", "lifecycles/hello-world/HelloWorld.PRPublished.md"],
        ["standard-fix-delivery@1", "profiles/standard-fix/StandardFix.PRPublished.md"],
    ]);
});

test("constructs conventional state paths from each source prefix", () => {
    assert.equal(
        lifecycleStateMarkdownPath({
            sourceId: "user",
            filePrefix: "CodeQLFix",
            basePath: "lifecycle/codeql",
        }, "Diagnosed"),
        "lifecycle/codeql/CodeQLFix.Diagnosed.md",
    );
    assert.equal(
        lifecycleStateMarkdownPath({
            sourceId: "platform",
            filePrefix: "StandardDelivery",
        }, "PRPublished"),
        "StandardDelivery.PRPublished.md",
    );
});

test("missing and multiply-defined states fail explicitly", async () => {
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Validated",
        sources: sources(),
        reader: inMemoryReader(stateFiles()),
    }), "state_not_found");

    const duplicateFiles = stateFiles();
    duplicateFiles.set(
        "hello-world-user:lifecycles/hello-world/HelloWorld.FixProposed.md",
        "# User fix proposed",
    );
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "FixProposed",
        sources: sources(),
        reader: inMemoryReader(duplicateFiles),
    }), "ambiguous_state");
});

test("does not inspect or validate Markdown transitions", async () => {
    const files = stateFiles();
    const brokenGraphMarkdown = [
        "# Work details gathered",
        "",
        "## Possible next states",
        "",
        "- [Missing](./HelloWorld.DoesNotExist.md)",
    ].join("\n");
    files.set(
        "hello-world-user:lifecycles/hello-world/HelloWorld.WorkDetailsGathered.md",
        brokenGraphMarkdown,
    );

    const loaded = await loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "WorkDetailsGathered",
        sources: sources(),
        reader: inMemoryReader(files),
    });
    assert.equal(loaded.markdown, brokenGraphMarkdown);
});

test("rejects malformed source configuration before invoking the reader", async () => {
    const reader = inMemoryReader(stateFiles());
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "../HelloWorld",
        state: "Diagnosed",
        sources: sources(),
        reader,
    }), "invalid_lifecycle_name");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Work Details Gathered",
        sources: sources(),
        reader,
    }), "invalid_state");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: null,
        reader,
    }), "invalid_sources");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: [null],
        reader,
    }), "invalid_source");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: [{ ...sources()[0], owner: "repository" }],
        reader,
    }), "invalid_owner");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: [{ ...sources()[0], filePrefix: "../HelloWorld" }],
        reader,
    }), "invalid_file_prefix");
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: [{ ...sources()[0], basePath: "../lifecycles" }],
        reader,
    }), "invalid_base_path");
});

test("rejects duplicate source identities and non-text reader results", async () => {
    const duplicateSources = [sources()[0], { ...sources()[1], sourceId: "hello-world-user" }];
    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: duplicateSources,
        reader: inMemoryReader(stateFiles()),
    }), "duplicate_source");

    await expectCode(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: [sources()[0]],
        reader: {
            async readStateMarkdown() {
                return Buffer.from("not text");
            },
        },
    }), "invalid_markdown");
});

test("source failures propagate instead of becoming false state-not-found results", async () => {
    const failure = new Error("repository unavailable");
    await assert.rejects(loadLifecycleStateMarkdown({
        lifecycleName: "HelloWorld",
        state: "Diagnosed",
        sources: sources(),
        reader: {
            async readStateMarkdown() {
                throw failure;
            },
        },
    }), (error) => error === failure);
});

test("remote reader loads GitHub content from the pinned commit", async () => {
    const requests = [];
    const reader = new RemoteLifecycleStateReader({
        githubToken: "test-token",
        fetch: async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response("# Pinned state\n", { status: 200 });
        },
    });
    const markdown = await reader.readStateMarkdown({
        sourceId: "github-source",
        owner: "user",
        filePrefix: "Example",
        kind: "github",
        repositoryUrl: "https://github.com/example/service-repo",
        resolvedCommit: "0123456789abcdef",
    }, "automation/Example.Initial.md");

    assert.equal(markdown, "# Pinned state\n");
    assert.equal(
        requests[0].url,
        "https://api.github.com/repos/example/service-repo/contents/automation/Example.Initial.md?ref=0123456789abcdef",
    );
    assert.match(requests[0].init.headers.authorization, /^Bearer /);
});

test("remote reader loads Azure DevOps content and treats only 404 as missing", async () => {
    const requests = [];
    const reader = new RemoteLifecycleStateReader({
        adoPat: "test-pat",
        fetch: async (url, init) => {
            requests.push({ url: new URL(String(url)), init });
            return new Response(JSON.stringify({ content: "# ADO state\n" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const markdown = await reader.readStateMarkdown({
        sourceId: "ado-source",
        owner: "platform",
        filePrefix: "Standard",
        kind: "ado",
        repositoryUrl: "https://dev.azure.com/example/Database%20Systems/_git/Lifecycle%20Profiles",
        resolvedCommit: "fedcba9876543210",
    }, "profiles/Standard.Initial.md");

    assert.equal(markdown, "# ADO state\n");
    assert.equal(requests[0].url.searchParams.get("path"), "/profiles/Standard.Initial.md");
    assert.equal(requests[0].url.searchParams.get("versionDescriptor.versionType"), "commit");
    assert.equal(requests[0].url.searchParams.get("versionDescriptor.version"), "fedcba9876543210");
    assert.match(requests[0].init.headers.authorization, /^Basic /);

    const missing = new RemoteLifecycleStateReader({
        adoPat: "test-pat",
        fetch: async () => new Response("", { status: 404 }),
    });
    assert.equal(await missing.readStateMarkdown({
        sourceId: "ado-source",
        owner: "platform",
        filePrefix: "Standard",
        repositoryUrl: "https://dev.azure.com/example/project/_git/repository",
        resolvedCommit: "fedcba",
    }, "missing.md"), null);
});

test("remote reader rejects mutable or failed reads", async () => {
    const reader = new RemoteLifecycleStateReader({
        githubToken: "test-token",
        fetch: async () => new Response("rate limited", { status: 429 }),
    });
    await assert.rejects(reader.readStateMarkdown({
        sourceId: "github-source",
        owner: "user",
        filePrefix: "Example",
        repositoryUrl: "https://github.com/example/service-repo",
        resolvedCommit: "abc",
    }, "Example.Initial.md"), /HTTP 429/);
    await assert.rejects(reader.readStateMarkdown({
        sourceId: "github-source",
        owner: "user",
        filePrefix: "Example",
        repositoryUrl: "https://github.com/example/service-repo",
    }, "Example.Initial.md"), /must pin resolvedCommit/);

    const githubDirectory = new RemoteLifecycleStateReader({
        githubToken: "test-token",
        fetch: async () => new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(githubDirectory.readStateMarkdown({
        sourceId: "github-source",
        owner: "user",
        filePrefix: "Example",
        repositoryUrl: "https://github.com/example/service-repo",
        resolvedCommit: "abc",
    }, "Example.Initial.md"), /did not return raw Markdown/);

    const adoSignIn = new RemoteLifecycleStateReader({
        adoToken: "expired-token",
        fetch: async () => new Response("<html>Sign in</html>", {
            status: 203,
            headers: { "content-type": "text/html" },
        }),
    });
    await assert.rejects(adoSignIn.readStateMarkdown({
        sourceId: "ado-source",
        owner: "user",
        filePrefix: "Example",
        repositoryUrl: "https://dev.azure.com/example/project/_git/repository",
        resolvedCommit: "abc",
    }, "Example.Initial.md"), /HTTP 203/);
});
