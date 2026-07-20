import AppKit
import Foundation

let uiPort = ProcessInfo.processInfo.environment["BAY_HOST_UI_PORT"] ?? "3410"
let uiURL = URL(string: "http://127.0.0.1:\(uiPort)")!

func resourcesDir() -> URL {
  Bundle.main.bundleURL
    .appendingPathComponent("Contents", isDirectory: true)
    .appendingPathComponent("Resources", isDirectory: true)
}

func nodeBinary() -> URL {
  resourcesDir()
    .appendingPathComponent("node", isDirectory: true)
    .appendingPathComponent("bin", isDirectory: true)
    .appendingPathComponent("node", isDirectory: false)
}

func appRoot() -> URL {
  resourcesDir().appendingPathComponent("app", isDirectory: true)
}

func pathPrefix() -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let extras = [
    nodeBinary().deletingLastPathComponent().path,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "\(home)/.local/bin",
    "/Applications/Tailscale.app/Contents/MacOS",
  ]
  let existing = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
  return (extras + [existing]).joined(separator: ":")
}

func alreadyRunning() -> Bool {
  var req = URLRequest(url: uiURL, timeoutInterval: 0.4)
  req.httpMethod = "GET"
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  URLSession.shared.dataTask(with: req) { _, response, _ in
    if let http = response as? HTTPURLResponse, http.statusCode == 200 {
      ok = true
    }
    sem.signal()
  }.resume()
  _ = sem.wait(timeout: .now() + 0.5)
  return ok
}

func openUI() {
  NSWorkspace.shared.open(uiURL)
}

func startHost() -> Int32 {
  let node = nodeBinary()
  let cli = appRoot().appendingPathComponent("src/cli.js")
  guard FileManager.default.isExecutableFile(atPath: node.path) else {
    fputs("Bay Host: bundled Node missing at \(node.path)\n", stderr)
    return 1
  }
  guard FileManager.default.fileExists(atPath: cli.path) else {
    fputs("Bay Host: cli.js missing at \(cli.path)\n", stderr)
    return 1
  }

  let process = Process()
  process.executableURL = node
  process.arguments = [cli.path, "serve"]
  var env = ProcessInfo.processInfo.environment
  env["PATH"] = pathPrefix()
  env["BAY_API_URL"] =
    env["BAY_API_URL"] ?? "https://bay-api-production.up.railway.app"
  env["BAY_BUNDLED_APP"] = "1"
  env["BAY_APP_BUNDLE"] = Bundle.main.bundlePath
  process.environment = env
  process.currentDirectoryURL = appRoot()

  do {
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  } catch {
    fputs("Bay Host failed to start: \(error)\n", stderr)
    return 1
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

if alreadyRunning() {
  openUI()
  exit(0)
}

exit(startHost())
