export async function registerTools(_worker) {
    return Promise.reject(new Error("Intentional async rejection inside registerTools."));
}
