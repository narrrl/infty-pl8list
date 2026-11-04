// The front end is built separately (`cd web && bun install --frozen-lockfile && bun run build`) and
// embedded from web/dist. Create the folder if it is missing so the backend still
// compiles (and its tests run) without Node; the pages are then empty.
fn main() {
    let dist = std::path::Path::new("../web/dist");
    println!("cargo:rerun-if-changed=../web/dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(dist).expect("create ../web/dist");
        println!("cargo:warning=web/dist has no index.html; run `bun run build` in web/ to include the front end");
    }
}
