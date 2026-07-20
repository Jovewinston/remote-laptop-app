import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var handled = false
  private var child: Process?

  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self else { return }
      if self.handled { return }
      let args = Array(CommandLine.arguments.dropFirst())
      if let first = args.first, first.hasPrefix("bay://") {
        self.runConnect(arguments: [first])
      } else if args.count >= 2 {
        self.runConnect(arguments: args)
      } else {
        self.showReadyDialog()
        NSApp.terminate(nil)
      }
    }
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    handled = true
    for url in urls {
      runConnect(arguments: [url.absoluteString])
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  private func resourcesDir() -> URL {
    Bundle.main.bundleURL
      .appendingPathComponent("Contents", isDirectory: true)
      .appendingPathComponent("Resources", isDirectory: true)
  }

  private func nodeBinary() -> URL {
    resourcesDir()
      .appendingPathComponent("node/bin/node", isDirectory: false)
  }

  private func cliPath() -> URL {
    resourcesDir()
      .appendingPathComponent("app/src/cli.js", isDirectory: false)
  }

  private func pathPrefix() -> String {
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

  private func runConnect(arguments: [String]) {
    if child != nil { return }

    let node = nodeBinary()
    let cli = cliPath()
    guard FileManager.default.isExecutableFile(atPath: node.path),
          FileManager.default.fileExists(atPath: cli.path)
    else {
      alert(
        title: "Bay Connect",
        text: "Bay Connect is missing its bundled runtime. Re-download the app from Bay."
      )
      NSApp.terminate(nil)
      return
    }

    let process = Process()
    process.executableURL = node
    process.arguments = [cli.path] + arguments
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = pathPrefix()
    env["BAY_API_URL"] =
      env["BAY_API_URL"] ?? "https://bay-api-production.up.railway.app"
    process.environment = env
    process.currentDirectoryURL = resourcesDir().appendingPathComponent("app")
    process.terminationHandler = { _ in
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
    }

    do {
      try process.run()
      child = process
    } catch {
      alert(title: "Bay Connect", text: "Could not start: \(error.localizedDescription)")
      NSApp.terminate(nil)
    }
  }

  private func showReadyDialog() {
    alert(
      title: "Bay Connect is ready",
      text: "On a Bay session page, click Connect. This app handles bay:// links and opens the tunnel.\n\nYou also need Tailscale signed in on this Mac."
    )
  }

  private func alert(title: String, text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.alertStyle = .informational
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
