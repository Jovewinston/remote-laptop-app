import AppKit
import Foundation

let uiPort = ProcessInfo.processInfo.environment["BAY_HOST_UI_PORT"] ?? "3410"
let uiURL = URL(string: "http://127.0.0.1:\(uiPort)")!
let stateURL = URL(string: "http://127.0.0.1:\(uiPort)/api/state")!

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var hostProcess: Process?
  private var pollTimer: Timer?
  private var lastStatus = "…"

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    if alreadyRunning() {
      // Another Host is already serving the cockpit — just focus it.
      openUI()
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
      return
    }

    setupStatusItem()
    startHostProcess()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      openUI()
    }

    pollTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
    refreshStatus()
  }

  func applicationWillTerminate(_ notification: Notification) {
    hostProcess?.terminate()
  }

  private func setupStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.title = "Bay · …"
      button.toolTip = "Bay Host"
    }
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Open Bay Host", action: #selector(openUIAction), keyEquivalent: "o"))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Quit Bay Host", action: #selector(quitAction), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  @objc private func openUIAction() {
    openUI()
  }

  @objc private func quitAction() {
    hostProcess?.terminate()
    NSApp.terminate(nil)
  }

  private func refreshStatus() {
    var req = URLRequest(url: stateURL, timeoutInterval: 1.5)
    req.httpMethod = "GET"
    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self else { return }
      var title = "Bay · off"
      if let data,
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        let menu = (json["menuStatus"] as? String) ?? "paused"
        switch menu {
        case "available": title = "Bay · on"
        case "busy": title = "Bay · busy"
        default: title = "Bay · pause"
        }
        self.lastStatus = menu
      }
      DispatchQueue.main.async {
        self.statusItem.button?.title = title
      }
    }.resume()
  }

  private func startHostProcess() {
    let node = nodeBinary()
    let cli = appRoot().appendingPathComponent("src/cli.js")
    guard FileManager.default.isExecutableFile(atPath: node.path),
          FileManager.default.fileExists(atPath: cli.path)
    else {
      fputs("Bay Host: bundled runtime missing\n", stderr)
      return
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
    // Swift opens the UI; avoid double browser tabs on relaunch quirks
    env["BAY_HOST_NO_BROWSER"] = "1"
    process.environment = env
    process.currentDirectoryURL = appRoot()
    process.terminationHandler = { _ in
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
    }
    do {
      try process.run()
      hostProcess = process
    } catch {
      fputs("Bay Host failed to start: \(error)\n", stderr)
    }
  }
}

func resourcesDir() -> URL {
  Bundle.main.bundleURL
    .appendingPathComponent("Contents", isDirectory: true)
    .appendingPathComponent("Resources", isDirectory: true)
}

func nodeBinary() -> URL {
  resourcesDir()
    .appendingPathComponent("node/bin/node", isDirectory: false)
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
    if let http = response as? HTTPURLResponse, (200 ... 499).contains(http.statusCode) {
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
