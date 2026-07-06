// @arch docs/features/wechat-rpa/macos-runtime.md
// @test src/__tests__/wechat-channel-native-helper.test.ts

import Foundation
import AppKit
import Vision
import CoreGraphics
import ApplicationServices
import CryptoKit
import IOKit.hid
import Darwin

let helperVersion = "0.1.12"
let protocolVersion = 1
let capabilities = [
  "screenCapture",
  "visionOcr",
  "windowList",
  "windowFocus",
  "mouseKeyboard",
  "clipboard",
  "contextMenu",
  "savePanel",
  "imageCropHash",
  "wechatSearch",
  "humanActivity",
  "automationLease",
]
let processStartedAt = Date()
var warmState = "cold"
var warmupMetrics: [String: Any] = ["startedAt": iso(processStartedAt)]
var ocrSampleCount = 0
var lastOcrMs: Double? = nil
var jsonOutput = FileHandle.standardOutput
let warmupLock = NSLock()
var warmupStarted = false

struct AutomationLease {
  let leaseId: String
  let owner: String
  let purpose: String
  let acquiredAt: Date
  let expiresAt: Date
  var interruptedAt: Date?
  var interruptReason: String?
  var expectedFrontmostBundleId: String?
  var expectedFrontmostLocalizedName: String?
}

var currentAutomationLease: AutomationLease? = nil
let automationLeaseLock = NSLock()
let syntheticEventMarker: Int64 = 0x53484E4E49414E
var automationEventTap: CFMachPort? = nil
var automationEventTapRunLoopSource: CFRunLoopSource? = nil
var automationEventTapThread: Thread? = nil

func iso(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

func nowMsSince(_ start: Date) -> Double {
  Date().timeIntervalSince(start) * 1000
}

func writeJSON(_ object: [String: Any], to output: FileHandle? = nil) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
    return
  }
  let handle = output ?? jsonOutput
  handle.write(data)
  handle.write(Data("\n".utf8))
}

func readFrame(_ line: String) -> [String: Any]? {
  guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    return nil
  }
  return object
}

func beginWarmupIfNeeded() -> Bool {
  warmupLock.lock()
  if warmupStarted {
    warmupLock.unlock()
    return false
  }
  warmupStarted = true
  warmState = "warming"
  warmupMetrics["warmupStartedAt"] = iso(Date())
  warmupLock.unlock()
  return true
}

func warmupVision() {
  if !beginWarmupIfNeeded() { return }
  runWarmupVision()
}

func startWarmupVisionInBackground() {
  if !beginWarmupIfNeeded() { return }

  let thread = Thread(block: {
    runWarmupVision()
  })
  thread.name = "shennian-wechat-helper-warmup"
  thread.start()
}

func runWarmupVision() {
  let warmupStartedAt = Date()
  warmupMetrics["warmupStartedAt"] = iso(warmupStartedAt)
  do {
    guard let cgImage = blankImage(width: 32, height: 32) else {
      throw HelperError("helper_warmup_failed", "Cannot allocate warmup image")
    }
    let firstStart = Date()
    _ = try recognizeText(cgImage: cgImage, width: 32, height: 32, fast: true)
    warmupMetrics["firstOcrMs"] = nowMsSince(firstStart)
    let warmStart = Date()
    _ = try recognizeText(cgImage: cgImage, width: 32, height: 32, fast: true)
    warmupMetrics["warmOcrMs"] = nowMsSince(warmStart)
    warmupMetrics["warmupMs"] = nowMsSince(warmupStartedAt)
    warmupMetrics["warmupCompletedAt"] = iso(Date())
    warmState = "warm"
  } catch {
    warmState = "failed"
    warmupMetrics["warmupMs"] = nowMsSince(warmupStartedAt)
    warmupMetrics["warmupCompletedAt"] = iso(Date())
    warmupMetrics["errorCode"] = errorCode(error)
    warmupMetrics["errorSummary"] = error.localizedDescription
  }
}

func blankImage(width: Int, height: Int) -> CGImage? {
  guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  context.setFillColor(NSColor.white.cgColor)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  return context.makeImage()
}

func readyFrame(expectedVersion: String?) -> [String: Any] {
  warmupMetrics["readyAt"] = iso(Date())
  warmupMetrics["coldStartMs"] = nowMsSince(processStartedAt)
  return [
    "type": "ready",
    "helperVersion": helperVersion,
    "protocolVersion": protocolVersion,
    "capabilities": capabilities,
    "pid": Int(ProcessInfo.processInfo.processIdentifier),
    "warmState": warmState,
    "warmup": currentWarmupSnapshot(),
  ]
}

struct HelperError: Error, LocalizedError {
  let code: String
  let summary: String
  init(_ code: String, _ summary: String) {
    self.code = code
    self.summary = summary
  }
  var errorDescription: String? { summary }
}

func errorCode(_ error: Error) -> String {
  if let helper = error as? HelperError { return helper.code }
  return "helper_command_failed"
}

func errorSummary(_ error: Error) -> String {
  if let helper = error as? HelperError { return helper.summary }
  return error.localizedDescription
}

func commandResponse(id: String, ok: Bool, result: Any? = nil, error: Error? = nil, latencyMs: Double, traceId: String?) -> [String: Any] {
  var response: [String: Any] = [
    "id": id,
    "ok": ok,
    "latencyMs": latencyMs,
    "warmState": warmState,
    "warmup": currentWarmupSnapshot(),
  ]
  if let traceId { response["traceId"] = traceId }
  if ok {
    if let result { response["result"] = result }
  } else {
    response["errorCode"] = error.map(errorCode) ?? "helper_command_failed"
    response["errorSummary"] = error.map(errorSummary) ?? "Command failed"
  }
  return response
}

func currentWarmupSnapshot() -> [String: Any] {
  var metrics = warmupMetrics
  if let lastOcrMs { metrics["lastOcrMs"] = lastOcrMs }
  metrics["ocrSampleCount"] = ocrSampleCount
  return metrics
}

func handleCommand(_ frame: [String: Any]) -> [String: Any] {
  let started = Date()
  let id = string(frame["id"]) ?? UUID().uuidString
  let traceId = string(frame["traceId"])
  let command = string(frame["command"]) ?? ""
  let params = frame["params"] as? [String: Any] ?? [:]
  do {
    let result = try execute(command: command, params: params)
    return commandResponse(id: id, ok: true, result: result, latencyMs: nowMsSince(started), traceId: traceId)
  } catch {
    return commandResponse(id: id, ok: false, error: error, latencyMs: nowMsSince(started), traceId: traceId)
  }
}

func execute(command: String, params: [String: Any]) throws -> Any {
  switch command {
  case "health.check": return healthCheck()
  case "permissions.check": return permissionsCheck()
  case "permissions.requestScreenRecording": return requestScreenRecordingPermission()
  case "permissions.requestAccessibility": return requestAccessibilityPermission()
  case "permissions.requestInputMonitoring": return requestInputMonitoringPermission()
  case "activity.snapshot": return activitySnapshot()
  case "automation.lease.acquire": return try automationLeaseAcquire(params)
  case "automation.lease.release": return automationLeaseRelease(params)
  case "automation.lease.status": return automationLeaseStatus()
  case "automation.lease.simulateInterruption": return automationLeaseSimulateInterruption(params)
  case "windows.ensureReady": return try ensureWeChatWindowReady(params)
  case "windows.list": return ["windows": listWindows()]
  case "windows.focus": return try focusWindow(params)
  case "windows.capture": return try captureWindow(params)
  case "windows.captureAndOcr": return try captureAndOcrWindow(params)
  case "screen.capture": return try captureScreen(params)
  case "ocr.recognize": return try ocrRecognize(params)
  case "mouse.click": return try mouseClick(params, button: .left)
  case "mouse.rightClick": return try mouseClick(params, button: .right)
  case "mouse.scroll": return try mouseScroll(params)
  case "keyboard.type": return try keyboardType(params)
  case "keyboard.shortcut": return try keyboardShortcut(params)
  case "clipboard.snapshot": return clipboardSnapshot()
  case "clipboard.restore": return try clipboardRestore(params)
  case "clipboard.setText": return try clipboardSetText(params)
  case "clipboard.setFiles": return try clipboardSetFiles(params)
  case "clipboard.readFileUrls": return clipboardReadFileUrls()
  case "clipboard.readAttachment": return clipboardReadAttachment()
  case "menu.pickItem": return try menuPickItem(params)
  case "savePanel.saveToPath": return try savePanelSaveToPath(params)
  case "image.cropHash": return try imageCropHash(params)
  case "wechat.searchConversation": return try wechatSearchConversation(params)
  case "wechat.focusMessageInput": return try wechatFocusMessageInput(params)
  default: throw HelperError("helper_unknown_command", "Unknown command: \(command)")
  }
}

func activitySnapshot() -> [String: Any] {
  return [
    "mouseMovedSecondsAgo": secondsSinceLastEvent(.mouseMoved),
    "leftMouseDownSecondsAgo": secondsSinceLastEvent(.leftMouseDown),
    "rightMouseDownSecondsAgo": secondsSinceLastEvent(.rightMouseDown),
    "scrollWheelSecondsAgo": secondsSinceLastEvent(.scrollWheel),
    "keyDownSecondsAgo": secondsSinceLastEvent(.keyDown),
    "frontmostApp": frontmostAppSnapshot(),
    "permissions": [
      "accessibilityTrusted": AXIsProcessTrusted(),
      "iohidListenGranted": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
      "iohidPostGranted": IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted,
    ],
    "privacy": [
      "capturesKeyContent": false,
      "capturesMousePath": false,
    ],
  ]
}

func secondsSinceLastEvent(_ eventType: CGEventType) -> Double {
  let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: eventType)
  if seconds.isFinite && seconds >= 0 { return seconds }
  return Double.greatestFiniteMagnitude
}

func frontmostAppSnapshot() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
  return [
    "bundleId": app.bundleIdentifier ?? "",
    "localizedName": app.localizedName ?? "",
  ]
}

func automationLeaseAcquire(_ params: [String: Any]) throws -> [String: Any] {
  cleanupExpiredAutomationLease()
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  if let existing = currentAutomationLease {
    throw HelperError("automation_lease_busy", "Automation lease is already active: \(existing.leaseId)")
  }
  let ttlMs = min(max(double(params["ttlMs"], fallback: 10_000), 500), 60_000)
  let lease = AutomationLease(
    leaseId: UUID().uuidString,
    owner: string(params["owner"]) ?? "wechat-channel",
    purpose: string(params["purpose"]) ?? "automation",
    acquiredAt: Date(),
    expiresAt: Date().addingTimeInterval(ttlMs / 1000),
    expectedFrontmostBundleId: nil,
    expectedFrontmostLocalizedName: nil
  )
  currentAutomationLease = lease
  do {
    try startAutomationEventTapLocked()
  } catch {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
    throw error
  }
  return automationLeasePayload(lease, active: true)
}

func automationLeaseRelease(_ params: [String: Any]) -> [String: Any] {
  cleanupExpiredAutomationLease()
  let leaseId = string(params["leaseId"]) ?? ""
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  if let existing = currentAutomationLease, existing.leaseId == leaseId {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
    return [
      "released": true,
      "leaseId": leaseId,
      "active": false,
    ]
  }
  return [
    "released": false,
    "leaseId": leaseId,
    "active": currentAutomationLease != nil,
  ]
}

func automationLeaseStatus() -> [String: Any] {
  cleanupExpiredAutomationLease()
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  refreshAutomationLeaseForegroundInterruptionLocked()
  if let existing = currentAutomationLease {
    return automationLeasePayload(existing, active: true)
  }
  return ["active": false]
}

func automationLeaseSimulateInterruption(_ params: [String: Any]) -> [String: Any] {
  cleanupExpiredAutomationLease()
  let reason = string(params["reason"]) ?? "recent_mouse_activity"
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  guard var lease = currentAutomationLease else {
    return [
      "active": false,
      "simulated": false,
      "reason": reason,
    ]
  }
  if lease.interruptedAt == nil {
    lease.interruptedAt = Date()
    lease.interruptReason = normalizeAutomationInterruptionReason(reason)
    currentAutomationLease = lease
  }
  return automationLeasePayload(lease, active: true).merging([
    "simulated": true,
  ]) { current, _ in current }
}

func cleanupExpiredAutomationLease() {
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  guard let existing = currentAutomationLease else { return }
  if existing.expiresAt <= Date() {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
  }
}

func automationLeasePayload(_ lease: AutomationLease, active: Bool) -> [String: Any] {
  var payload: [String: Any] = [
    "active": active,
    "leaseId": lease.leaseId,
    "owner": lease.owner,
    "purpose": lease.purpose,
    "acquiredAt": iso(lease.acquiredAt),
    "expiresAt": iso(lease.expiresAt),
    "interrupted": lease.interruptedAt != nil,
  ]
  if let interruptedAt = lease.interruptedAt {
    payload["interruptedAt"] = iso(interruptedAt)
  }
  if let reason = lease.interruptReason {
    payload["interruptReason"] = reason
  }
  if lease.expectedFrontmostBundleId != nil || lease.expectedFrontmostLocalizedName != nil {
    payload["expectedFrontmostApp"] = [
      "bundleId": lease.expectedFrontmostBundleId ?? "",
      "localizedName": lease.expectedFrontmostLocalizedName ?? "",
    ]
  }
  payload["frontmostApp"] = frontmostAppSnapshot()
  return payload
}

let automationEventTapCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    automationLeaseLock.lock()
    if let tap = automationEventTap {
      CGEvent.tapEnable(tap: tap, enable: true)
    }
    automationLeaseLock.unlock()
    return Unmanaged.passUnretained(event)
  }
  guard isAutomationInterruptEvent(type) else {
    return Unmanaged.passUnretained(event)
  }
  if isSyntheticAutomationEvent(event) {
    return Unmanaged.passUnretained(event)
  }
  markAutomationLeaseInterrupted(reason: automationInterruptReason(type))
  return Unmanaged.passUnretained(event)
}

func startAutomationEventTapLocked() throws {
  stopAutomationEventTapLocked()
  let mask = automationInterruptEventMask()
  guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: automationEventTapCallback,
    userInfo: nil
  ) else {
    throw HelperError("automation_event_tap_unavailable", "Cannot create listen-only event tap for automation lease")
  }
  guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    CFMachPortInvalidate(tap)
    throw HelperError("automation_event_tap_unavailable", "Cannot create event tap run loop source")
  }
  automationEventTap = tap
  automationEventTapRunLoopSource = source
  let thread = Thread(block: {
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    CFRunLoopRun()
  })
  thread.name = "shennian-wechat-automation-lease"
  automationEventTapThread = thread
  thread.start()
}

func stopAutomationEventTapLocked() {
  if let tap = automationEventTap {
    CGEvent.tapEnable(tap: tap, enable: false)
    CFMachPortInvalidate(tap)
  }
  automationEventTap = nil
  automationEventTapRunLoopSource = nil
  automationEventTapThread = nil
}

func markAutomationLeaseInterrupted(reason: String) {
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  guard var lease = currentAutomationLease else { return }
  if lease.expiresAt <= Date() {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
    return
  }
  if lease.interruptedAt == nil {
    lease.interruptedAt = Date()
    lease.interruptReason = reason
    currentAutomationLease = lease
  }
}

func noteAutomationLeaseExpectedFrontmostApp(_ app: NSRunningApplication?) {
  guard let app else { return }
  automationLeaseLock.lock()
  defer { automationLeaseLock.unlock() }
  guard var lease = currentAutomationLease else { return }
  if lease.expiresAt <= Date() {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
    return
  }
  lease.expectedFrontmostBundleId = app.bundleIdentifier ?? ""
  lease.expectedFrontmostLocalizedName = app.localizedName ?? ""
  currentAutomationLease = lease
}

func noteAutomationLeaseExpectedWeChatFrontmost() {
  noteAutomationLeaseExpectedFrontmostApp(findWeChatRunningApplication())
}

func refreshAutomationLeaseForegroundInterruptionLocked() {
  guard var lease = currentAutomationLease else { return }
  if lease.expiresAt <= Date() {
    currentAutomationLease = nil
    stopAutomationEventTapLocked()
    return
  }
  if lease.interruptedAt != nil { return }
  let expectedBundleId = (lease.expectedFrontmostBundleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let expectedName = (lease.expectedFrontmostLocalizedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if expectedBundleId.isEmpty && expectedName.isEmpty { return }
  guard let current = NSWorkspace.shared.frontmostApplication else { return }
  let currentBundleId = (current.bundleIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let currentName = (current.localizedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let bundleMatches = !expectedBundleId.isEmpty && currentBundleId == expectedBundleId
  let nameMatches = expectedBundleId.isEmpty && !expectedName.isEmpty && currentName == expectedName
  if bundleMatches || nameMatches { return }
  lease.interruptedAt = Date()
  lease.interruptReason = "frontmost_app_changed"
  currentAutomationLease = lease
}

func isAutomationInterruptEvent(_ type: CGEventType) -> Bool {
  switch type {
  case .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown, .flagsChanged:
    return true
  default:
    return false
  }
}

func automationInterruptReason(_ type: CGEventType) -> String {
  switch type {
  case .keyDown, .flagsChanged: return "recent_keyboard_activity"
  case .leftMouseDown, .rightMouseDown, .otherMouseDown: return "recent_mouse_click"
  case .scrollWheel: return "recent_scroll_activity"
  default: return "recent_mouse_activity"
  }
}

func normalizeAutomationInterruptionReason(_ reason: String) -> String {
  switch reason {
  case "recent_mouse_activity",
       "recent_mouse_click",
       "recent_scroll_activity",
       "recent_keyboard_activity",
       "frontmost_app_changed":
    return reason
  default:
    return "user_activity_unknown"
  }
}

func automationInterruptEventMask() -> CGEventMask {
  let types: [CGEventType] = [
    .mouseMoved,
    .leftMouseDown,
    .rightMouseDown,
    .otherMouseDown,
    .scrollWheel,
    .keyDown,
    .flagsChanged,
  ]
  return types.reduce(CGEventMask(0)) { mask, type in
    mask | (CGEventMask(1) << CGEventMask(type.rawValue))
  }
}

func isSyntheticAutomationEvent(_ event: CGEvent) -> Bool {
  if event.getIntegerValueField(.eventSourceUserData) == syntheticEventMarker {
    return true
  }
  let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
  return sourcePid == Int64(ProcessInfo.processInfo.processIdentifier)
}

func markSyntheticAutomationEvent(_ event: CGEvent) {
  event.setIntegerValueField(.eventSourceUserData, value: syntheticEventMarker)
}

func healthCheck() -> [String: Any] {
  return [
    "ok": true,
    "helperVersion": helperVersion,
    "protocolVersion": protocolVersion,
    "capabilities": capabilities,
    "pid": Int(ProcessInfo.processInfo.processIdentifier),
    "uptimeMs": nowMsSince(processStartedAt),
    "warmState": warmState,
    "warmup": currentWarmupSnapshot(),
  ]
}

func permissionsCheck() -> [String: Any] {
  let windows = listWeChatWindows()
  let running = findWeChatRunningApplication() != nil
  let available = windows.contains(where: isWeChatWindowCaptureCandidate)
  return [
    "screenRecording": hasScreenRecordingAccess(),
    "accessibility": AXIsProcessTrusted(),
    "inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
    "automation": true,
    "wechatRunning": running,
    "wechatWindowAvailable": available,
  ]
}

func hasScreenRecordingAccess() -> Bool {
  if CGPreflightScreenCaptureAccess() { return true }
  return canCaptureTinyScreenshot()
}

func canCaptureTinyScreenshot() -> Bool {
  let outputPath = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("shennian-screen-probe-\(UUID().uuidString).png")
    .path
  defer { try? FileManager.default.removeItem(atPath: outputPath) }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-R0,0,1,1", outputPath]
  do {
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return false }
    let attributes = try? FileManager.default.attributesOfItem(atPath: outputPath)
    return (attributes?[.size] as? NSNumber)?.intValue ?? 0 > 0
  } catch {
    return false
  }
}

func requestScreenRecordingPermission() -> [String: Any] {
  let before = CGPreflightScreenCaptureAccess()
  let granted = before || CGRequestScreenCaptureAccess()
  return [
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "wasGrantedBeforeRequest": before,
    "requestReturnedGranted": granted,
  ]
}

func requestAccessibilityPermission() -> [String: Any] {
  let before = AXIsProcessTrusted()
  let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
  return [
    "accessibility": AXIsProcessTrusted(),
    "wasGrantedBeforeRequest": before,
    "requestReturnedGranted": trusted,
  ]
}

func requestInputMonitoringPermission() -> [String: Any] {
  let listenBefore = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
  let postBefore = IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted
  let listenGranted = listenBefore || IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
  return [
    "iohidListenGranted": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
    "iohidPostGranted": IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted,
    "listenWasGrantedBeforeRequest": listenBefore,
    "postWasGrantedBeforeRequest": postBefore,
    "listenRequestReturnedGranted": listenGranted,
  ]
}

func ensureWeChatWindowReady(_ params: [String: Any]) throws -> [String: Any] {
  guard let app = findWeChatRunningApplication() else {
    throw HelperError("wechat_not_running", "WeChat is not running")
  }
  let shouldRestore = bool(params["restore"], fallback: true)
  let shouldFocus = bool(params["focus"], fallback: true)
  let mayActivateForeground = shouldRestore || shouldFocus

  // Fast path: within the same send flow every high-level step (select
  // window, open conversation, focus input, recovery) calls this function
  // independently, and each call re-runs a full ~5s restore/wait
  // ceremony even when WeChat is already frontmost and capturable. Short
  // circuit that common case: if WeChat is already the frontmost app with an
  // on-screen, capturable main window, return it directly. The fast path is
  // skipped when the caller explicitly needs recovery (allowRecovery: true)
  // or when the env override disables it. Cold-start, minimized, off-screen
  // and multi-display recovery all still fall through to the full path.
  let allowRecovery = bool(params["allowRecovery"], fallback: false)
  let fastPathDisabled = ProcessInfo.processInfo.environment["SHENNIAN_WECHAT_ENSURE_READY_FAST_PATH"] == "0"
  if !fastPathDisabled && !allowRecovery {
    let frontmostBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    let wechatFrontmost = frontmostBundle == app.bundleIdentifier
    if !shouldFocus || wechatFrontmost {
      let currentWindows = listWeChatWindows()
      if let capturable = currentWindows.first(where: isWeChatWindowCaptureCandidate),
         let bounds = rectFromWindowInfo(capturable),
         rectIntersectsAnyDisplay(bounds) {
        if mayActivateForeground {
          noteAutomationLeaseExpectedWeChatFrontmost()
        }
        return capturable
      }
    }
  }

  if mayActivateForeground {
    hideSystemPermissionObstructions()
  }
  if shouldRestore {
    restoreWeChatWindows()
  } else if shouldFocus {
    _ = app.unhide()
    _ = activateWeChatApplication(app)
  }

  if mayActivateForeground {
    _ = app.unhide()
    _ = activateWeChatApplication(app)
    usleep(250_000)
  }

  var windows = listWeChatWindows()
  if windows.isEmpty && shouldRestore {
    _ = activateWeChatApplication(app)
    usleep(800_000)
    windows = listWeChatWindows()
  }

  if shouldRestore && windows.filter(isWeChatWindowCaptureCandidate).isEmpty,
     let offscreenWindow = selectWeChatWindowCandidate(listWeChatWindows(includeOffscreen: true)) {
    _ = try? focusWindow(["windowId": offscreenWindow["windowId"] as? String ?? ""])
    windows = waitForVisibleWeChatWindows(timeoutMs: 1500)
  }

  guard let window = selectWeChatWindowCandidate(windows) else {
    throw HelperError("wechat_window_unavailable", "Cannot find an available WeChat window")
  }

  var selected = window
  if shouldFocus {
    _ = try? focusWindow(["windowId": selected["windowId"] as? String ?? ""])
    usleep(180_000)
    let refreshed = listWeChatWindows()
    let focused = selectWeChatWindowCandidate(refreshed, preferredWindowId: window["windowId"] as? String)
      ?? window
    if let bounds = rectFromWindowInfo(focused), !rectIntersectsAnyDisplay(bounds) {
      let visible = waitForVisibleWeChatWindows(timeoutMs: 1500)
      if let visibleWindow = selectWeChatWindowCandidate(visible),
         let visibleBounds = rectFromWindowInfo(visibleWindow),
         rectIntersectsAnyDisplay(visibleBounds) {
        if mayActivateForeground {
          noteAutomationLeaseExpectedWeChatFrontmost()
        }
        return visibleWindow
      }
      throw HelperError("wechat_window_unavailable", "WeChat main window is not on a capturable display")
    }
    selected = focused
  }

  let capturable = try recoverCapturableWeChatWindow(
    selected,
    app: app,
    shouldRestore: shouldRestore,
    shouldFocus: shouldFocus
  )
  if mayActivateForeground {
    noteAutomationLeaseExpectedWeChatFrontmost()
  }
  return capturable
}

func recoverCapturableWeChatWindow(
  _ selected: [String: Any],
  app: NSRunningApplication,
  shouldRestore: Bool,
  shouldFocus: Bool
) throws -> [String: Any] {
  if isWeChatWindowCaptureCandidate(selected) { return selected }
  guard shouldRestore else {
    throw HelperError("wechat_window_capture_failed", "WeChat window exists but cannot be captured by CoreGraphics")
  }

  restoreWeChatWindows()
  var windows = waitForVisibleWeChatWindows(timeoutMs: 1800)
  if windows.isEmpty {
    windows = listWeChatWindows()
  }

  let preferredId = selected["windowId"] as? String
  let candidates = orderedWeChatWindowCandidates(windows, preferredWindowId: preferredId)
  for candidate in candidates {
    if shouldFocus {
      _ = try? focusWindow(["windowId": candidate["windowId"] as? String ?? ""])
      usleep(180_000)
    }
    let refreshed = selectWeChatWindowCandidate(listWeChatWindows(), preferredWindowId: candidate["windowId"] as? String)
      ?? candidate
    if isWeChatWindowCaptureCandidate(refreshed) {
      return refreshed
    }
  }

  throw HelperError("wechat_window_capture_failed", "WeChat window exists but cannot be captured by CoreGraphics")
}

func orderedWeChatWindowCandidates(_ windows: [[String: Any]], preferredWindowId: String?) -> [[String: Any]] {
  var result: [[String: Any]] = []
  if let preferredWindowId,
     let preferred = windows.first(where: { ($0["windowId"] as? String) == preferredWindowId }) {
    result.append(preferred)
  }
  for window in windows {
    if !result.contains(where: { ($0["windowId"] as? String) == (window["windowId"] as? String) }) {
      result.append(window)
    }
  }
  return result
}

func isWindowCapturable(_ window: [String: Any]) -> Bool {
  guard let raw = string(window["windowId"]), let value = UInt32(raw) else { return false }
  guard let image = CGWindowListCreateImage(
    CGRect.null,
    .optionIncludingWindow,
    CGWindowID(value),
    .boundsIgnoreFraming
  ) else { return false }
  return image.width > 0 && image.height > 0
}

func isWeChatWindowCaptureCandidate(_ window: [String: Any]) -> Bool {
  return isWindowCapturable(window) || isCapturableWindowMetadata(window)
}

func listWindows() -> [[String: Any]] {
  return listWindows(includeOffscreen: false)
}

func listWindows(includeOffscreen: Bool) -> [[String: Any]] {
  let options: CGWindowListOption = includeOffscreen
    ? [.optionAll, .excludeDesktopElements]
    : [.optionOnScreenOnly, .excludeDesktopElements]
  guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
  return raw.compactMap { item in
    let layer = item[kCGWindowLayer as String] as? Int ?? 0
    guard layer == 0 else { return nil }
    guard let number = item[kCGWindowNumber as String] as? UInt32 else { return nil }
    let bounds = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = double(bounds["X"])
    let y = double(bounds["Y"])
    let width = double(bounds["Width"])
    let height = double(bounds["Height"])
    guard width > 0, height > 0 else { return nil }
    let sharingState = Int(double(item[kCGWindowSharingState as String]))
    let memoryUsage = Int(double(item[kCGWindowMemoryUsage as String]))
    let isOnscreen = bool(item[kCGWindowIsOnscreen as String])
    return [
      "windowId": String(number),
      "ownerPid": item[kCGWindowOwnerPID as String] as? Int32 ?? 0,
      "appName": item[kCGWindowOwnerName as String] as? String ?? "",
      "title": item[kCGWindowName as String] as? String ?? "",
      "bounds": ["x": x, "y": y, "width": width, "height": height, "coordinateSpace": "screen"],
      "sharingState": sharingState,
      "memoryUsage": memoryUsage,
      "visible": includeOffscreen ? rectIntersectsAnyDisplay(CGRect(x: x, y: y, width: width, height: height)) : isOnscreen,
      "minimized": false,
    ]
  }
}

func listWeChatWindows() -> [[String: Any]] {
  return listWeChatWindows(includeOffscreen: false)
}

func listWeChatWindows(includeOffscreen: Bool) -> [[String: Any]] {
  return listWindows(includeOffscreen: includeOffscreen).filter(isWeChatWindow)
}

func isWeChatWindow(_ window: [String: Any]) -> Bool {
  let ownerPid = Int(double(window["ownerPid"], fallback: -1))
  if ownerPid > 0,
     let app = findWeChatRunningApplication(),
     ownerPid == Int(app.processIdentifier) {
    return true
  }
  return isWeChatApplicationName(window["appName"] as? String)
}

func selectWeChatWindowCandidate(_ windows: [[String: Any]], preferredWindowId: String? = nil) -> [String: Any]? {
  let capturableWindows = windows.filter(isWeChatWindowCaptureCandidate)
  if let preferredWindowId, let preferred = capturableWindows.first(where: { ($0["windowId"] as? String) == preferredWindowId }) {
    return preferred
  }
  return capturableWindows.first
}

func isCapturableWindowMetadata(_ window: [String: Any]) -> Bool {
  guard window.keys.contains("sharingState") else { return true }
  if Int(double(window["sharingState"])) > 0 { return true }
  guard isWeChatWindow(window), bool(window["visible"], fallback: true), !bool(window["minimized"]) else { return false }
  guard let bounds = rectFromWindowInfo(window) else { return false }
  return rectIntersectsAnyDisplay(bounds)
}

func restoreWeChatWindows() {
  hideSystemPermissionObstructions()
  runWeChatReopenScript()
  guard let app = findWeChatRunningApplication() else { return }
  _ = app.unhide()
  _ = activateWeChatApplication(app)
  raiseAXApp(pid: app.processIdentifier)
  Thread.sleep(forTimeInterval: 0.5)
  if listWeChatWindows().isEmpty {
    restoreWeChatWindowsViaAccessibilityMenu()
    raiseAXApp(pid: app.processIdentifier)
  }
  Thread.sleep(forTimeInterval: 0.5)
}

func waitForVisibleWeChatWindows(timeoutMs: Int) -> [[String: Any]] {
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
  repeat {
    let windows = listWeChatWindows()
    if !windows.filter(isWeChatWindowCaptureCandidate).isEmpty {
      return windows
    }
    usleep(120_000)
  } while Date() < deadline
  return listWeChatWindows()
}

func restoreWeChatWindowsViaAccessibilityMenu() {
  guard AXIsProcessTrusted(), let app = findWeChatRunningApplication() else { return }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  for label in ["前置全部窗口", "微信", "微信 (窗口)"] {
    if let item = findMenuItemInMenu(axApp, menuLabels: ["窗口", "Window"], itemLabels: [label]),
       AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success {
      usleep(250_000)
    }
  }
}

func runWeChatReopenScript() {
  let target = weChatAppleScriptTarget()
  let source = """
tell \(target)
  reopen
  activate
end tell
delay 0.2
tell application "System Events"
  if exists process "WeChat" then
    tell process "WeChat"
      set frontmost to true
      repeat with candidateWindow in windows
        try
          set value of attribute "AXMinimized" of candidateWindow to false
        end try
        try
          perform action "AXRaise" of candidateWindow
        end try
      end repeat
      try
        click menu item "前置全部窗口" of menu 1 of menu bar item "窗口" of menu bar 1
      end try
      try
        click menu item "微信" of menu 1 of menu bar item "窗口" of menu bar 1
      end try
      try
        click menu item "微信 (窗口)" of menu 1 of menu bar item "窗口" of menu bar 1
      end try
    end tell
  end if
end tell
"""
  var errorInfo: NSDictionary?
  _ = NSAppleScript(source: source)?.executeAndReturnError(&errorInfo)
}

func focusWindow(_ params: [String: Any]) throws -> [String: Any] {
  let windowId = try cgWindowId(params)
  guard let ownerPid = ownerPid(windowId: windowId), let app = NSRunningApplication(processIdentifier: ownerPid) else {
    throw HelperError("wechat_window_unavailable", "Cannot find owning app for window \(windowId)")
  }
  hideSystemPermissionObstructions()
  _ = app.unhide()
  let activated = activateWeChatApplication(app)
  raiseAXApp(pid: ownerPid, windowId: windowId)
  noteAutomationLeaseExpectedFrontmostApp(app)
  return ["focused": activated, "pid": Int(ownerPid), "windowId": String(windowId)]
}

struct CapturedWindowImage {
  let windowId: CGWindowID
  let data: Data
  let image: CGImage
  let width: Int
  let height: Int
  let captureMode: String
}

func captureWindowImage(_ params: [String: Any]) throws -> CapturedWindowImage {
  let windowId = try cgWindowId(params)
  return try captureWindowById(windowId)
}

func captureWindowById(_ windowId: CGWindowID) throws -> CapturedWindowImage {
  if let image = CGWindowListCreateImage(
    CGRect.null,
    .optionIncludingWindow,
    windowId,
    .boundsIgnoreFraming
  ) {
    return try encodedCapturedWindowImage(
      windowId: windowId,
      image: image,
      captureMode: "cg-window-list-image"
    )
  }

  guard let window = listWindows().first(where: { ($0["windowId"] as? String) == String(windowId) }),
        isWeChatWindow(window),
        let bounds = rectFromWindowInfo(window),
        rectIntersectsAnyDisplay(bounds) else {
    throw HelperError("wechat_window_capture_failed", "Cannot capture WeChat window \(windowId) with CoreGraphics")
  }
  return try captureScreenBoundsImage(
    bounds: bounds,
    windowId: windowId,
    captureMode: "cg-screen-bounds-window-fallback"
  )
}

func encodedCapturedWindowImage(windowId: CGWindowID, image: CGImage, captureMode: String) throws -> CapturedWindowImage {
  let rep = NSBitmapImageRep(cgImage: image)
  guard let data = rep.representation(using: .png, properties: [:]) else {
    throw HelperError("wechat_window_capture_failed", "Cannot encode WeChat window \(windowId)")
  }
  return CapturedWindowImage(
    windowId: windowId,
    data: data,
    image: image,
    width: rep.pixelsWide,
    height: rep.pixelsHigh,
    captureMode: captureMode
  )
}

func captureWindow(_ params: [String: Any]) throws -> [String: Any] {
  let captured = try captureWindowImage(params)
  return [
    "mimeType": "image/png",
    "dataBase64": captured.data.base64EncodedString(),
    "width": captured.width,
    "height": captured.height,
    "windowId": String(captured.windowId),
    "captureMode": captured.captureMode,
  ]
}

func captureScreen(_ params: [String: Any]) throws -> [String: Any] {
  let bounds = screenCaptureBounds(params)
  let captured = try captureScreenBoundsImage(
    bounds: bounds,
    windowId: 0,
    captureMode: "cg-screen-bounds"
  )
  return [
    "mimeType": "image/png",
    "dataBase64": captured.data.base64EncodedString(),
    "width": captured.width,
    "height": captured.height,
    "captureMode": captured.captureMode,
    "bounds": [
      "x": bounds.origin.x,
      "y": bounds.origin.y,
      "width": bounds.width,
      "height": bounds.height,
      "coordinateSpace": "screen",
    ],
  ]
}

func captureScreenBoundsImage(bounds: CGRect, windowId: CGWindowID, captureMode: String) throws -> CapturedWindowImage {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let image = CGWindowListCreateImage(bounds, options, kCGNullWindowID, [.bestResolution]) else {
    throw HelperError("screen_capture_failed", "Cannot capture screen bounds")
  }
  let rep = NSBitmapImageRep(cgImage: image)
  guard let data = rep.representation(using: .png, properties: [:]) else {
    throw HelperError("screen_capture_failed", "Cannot encode screen capture")
  }
  return CapturedWindowImage(
    windowId: windowId,
    data: data,
    image: image,
    width: rep.pixelsWide,
    height: rep.pixelsHigh,
    captureMode: captureMode
  )
}

func screenCaptureBounds(_ params: [String: Any]) -> CGRect {
  if let rawBounds = params["bounds"] as? [String: Any] {
    let x = double(rawBounds["x"])
    let y = double(rawBounds["y"])
    let width = max(1, double(rawBounds["width"], fallback: 1))
    let height = max(1, double(rawBounds["height"], fallback: 1))
    return CGRect(x: x, y: y, width: width, height: height)
  }
  if let screen = NSScreen.main ?? NSScreen.screens.first {
    return screen.frame
  }
  return CGRect(x: 0, y: 0, width: 1440, height: 900)
}

func captureAndOcrWindow(_ params: [String: Any]) throws -> [String: Any] {
  let captured = try captureWindowImage(params)
  let started = Date()
  let blocks = try recognizeText(cgImage: captured.image, width: captured.width, height: captured.height, fast: bool(params["fast"]))
  lastOcrMs = nowMsSince(started)
  ocrSampleCount += 1
  let ocr: [String: Any] = [
    "blocks": blocks,
    "visibleConversationFingerprints": visibleConversationFingerprints(blocks: blocks, width: captured.width, height: captured.height),
    "warmState": warmState,
    "warmup": currentWarmupSnapshot(),
  ]
  var capture: [String: Any] = [
    "mimeType": "image/png",
    "width": captured.width,
    "height": captured.height,
    "windowId": String(captured.windowId),
    "captureMode": captured.captureMode,
  ]
  if bool(params["includeImage"]) {
    capture["dataBase64"] = captured.data.base64EncodedString()
  }
  return [
    "capture": capture,
    "ocr": ocr,
  ]
}

func ocrRecognize(_ params: [String: Any]) throws -> [String: Any] {
  let decoded = try decodeImage(params)
  let started = Date()
  let blocks = try recognizeText(cgImage: decoded.image, width: decoded.width, height: decoded.height, fast: bool(params["fast"]))
  lastOcrMs = nowMsSince(started)
  ocrSampleCount += 1
  return [
    "blocks": blocks,
    "visibleConversationFingerprints": visibleConversationFingerprints(blocks: blocks, width: decoded.width, height: decoded.height),
    "warmState": warmState,
    "warmup": currentWarmupSnapshot(),
  ]
}

func recognizeText(cgImage: CGImage, width: Int, height: Int, fast: Bool) throws -> [[String: Any]] {
  var output: [[String: Any]] = []
  let request = VNRecognizeTextRequest { request, error in
    if error != nil { return }
    let observations = request.results as? [VNRecognizedTextObservation] ?? []
    output = observations.compactMap { observation in
      guard let top = observation.topCandidates(1).first else { return nil }
      let box = observation.boundingBox
      return [
        "text": top.string,
        "confidence": Double(top.confidence),
        "bbox": [
          "x": box.minX * Double(width),
          "y": (1 - box.maxY) * Double(height),
          "width": box.width * Double(width),
          "height": box.height * Double(height),
          "coordinateSpace": "screenshotPixel",
        ],
      ]
    }
  }
  request.recognitionLevel = fast ? .fast : .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
  return output
}

private struct FingerprintItem {
  let text: String
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  var cx: Double { x + w / 2 }
  var cy: Double { y + h / 2 }
}

private let fingerprintTimeRegexes: [NSRegularExpression] = [
  "^(星期[一二三四五六日天])$",
  "^(周[一二三四五六日天])\\s*\\d{0,2}:?\\d{0,2}$",
  "^(昨天|今天|前天)\\s*\\d{1,2}:\\d{2}$",
  "^\\d{1,2}:\\d{2}(?::\\d{2})?$",
  "^\\d{4}[-/.年]\\d{1,2}(?:[-/.月]\\d{1,2}日?)?$",
  "^\\d{1,2}[-/.月]\\d{1,2}日?$",
].compactMap { try? NSRegularExpression(pattern: $0) }

private func matchesRegex(_ regex: NSRegularExpression, _ value: String) -> Bool {
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.firstMatch(in: value, range: range) != nil
}

private func isLikelyTimeText(_ text: String) -> Bool {
  let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return fingerprintTimeRegexes.contains { matchesRegex($0, v) }
}

private func isNoiseText(_ text: String) -> Bool {
  let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if v.count <= 1 { return true }
  if let re = try? NSRegularExpression(pattern: "^[•·⋯…]+$"), matchesRegex(re, v) { return true }
  if let re = try? NSRegularExpression(pattern: "^[①-⓿❶-➓]+$"), matchesRegex(re, v) { return true }
  return false
}

private func normalizeFingerprintTitle(_ value: String) -> String {
  return value.trimmingCharacters(in: .whitespacesAndNewlines)
    .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func isNonConversationListText(_ title: String) -> Bool {
  return ["搜索", "微信", "通讯录", "收藏", "设置", "Search"].contains(title.trimmingCharacters(in: .whitespacesAndNewlines))
}

// 会话列表指纹行聚类 —— 与 .dev-runtime/fingerprint-cluster-ref.mjs / Windows helper 保持完全一致的几何规则。
// 阈值全部用百分比(相对截图宽高),不写死像素,兼容不同窗口尺寸。
func visibleConversationFingerprints(blocks: [[String: Any]], width: Int, height: Int) -> [[String: Any]] {
  let items = blocks.compactMap { block -> FingerprintItem? in
    guard let rawText = block["text"] as? String, let bbox = block["bbox"] as? [String: Any] else { return nil }
    let text = normalizeFingerprintTitle(rawText)
    if text.count < 1 || isNoiseText(text) { return nil }
    return FingerprintItem(text: text, x: double(bbox["x"]), y: double(bbox["y"]), w: double(bbox["width"]), h: double(bbox["height"]))
  }

  let W = Double(width), H = Double(height)
  let titleXLo = W * 0.10, titleXHi = W * 0.20
  let timeXLo = W * 0.24, timeXHi = W * 0.36
  let topBarY = H * 0.12
  let bottomY = H * 0.96
  let rowYTol = H * 0.02
  // Windows 标题↔预览≈3.3%H;Mac 标题↔预览≈2.4%H。取 4%H,既能吸预览又不并下一行(Mac 行距 7%H)。
  let titleGap = H * 0.04

  func inTitleCol(_ b: FingerprintItem) -> Bool { b.x > titleXLo && b.x < titleXHi }
  func inTimeCol(_ b: FingerprintItem) -> Bool { b.x > timeXLo && b.x < timeXHi }

  let leftCol = items
    .filter { inTitleCol($0) && $0.y > topBarY && $0.y < bottomY }
    .filter { !isNonConversationListText($0.text) }
    .sorted { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }

  let timeBlocks = items
    .filter { inTimeCol($0) && $0.y > topBarY && $0.y < bottomY && isLikelyTimeText($0.text) }
    .sorted { $0.y < $1.y }

  let titleBoxes = leftCol
    .filter { !isLikelyTimeText($0.text) }
    .filter { b in !leftCol.contains { o in o.y < b.y && b.y - o.y < titleGap && o.text != b.text } }
    .sorted { $0.y < $1.y }

  func boxOf(_ b: FingerprintItem?) -> [String: Any]? {
    guard let b = b else { return nil }
    return ["x": b.x, "y": b.y, "w": b.w, "h": b.h, "coordinateSpace": "screenshotPixel"]
  }

  var seen = Set<String>()
  var result: [[String: Any]] = []
  for i in titleBoxes.indices {
    let titleBox = titleBoxes[i]
    let nextTitleY = i + 1 < titleBoxes.count ? titleBoxes[i + 1].y : Double.infinity
    let previewBox = leftCol.first { b in
      b.text != titleBox.text && b.y > titleBox.y && b.y < nextTitleY && !isLikelyTimeText(b.text)
    }
    let timeBox = timeBlocks.first { abs($0.cy - titleBox.cy) <= rowYTol }

    let title = titleBox.text
    if seen.contains(title) { continue }
    seen.insert(title)
    let preview = previewBox?.text
    let timeText = timeBox?.text
    let fingerprint = [title, preview, timeText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "|")
    var entry: [String: Any] = [
      "title": title,
      "fingerprint": fingerprint,
    ]
    entry["preview"] = preview as Any
    entry["timeText"] = timeText as Any
    entry["unreadText"] = NSNull()
    // bbox = 标题行点击目标(供 CLI 点击会话用),沿用 width/height 命名。
    entry["bbox"] = ["x": titleBox.x, "y": titleBox.y, "width": titleBox.w, "height": titleBox.h, "coordinateSpace": "screenshotPixel"]
    entry["titleBox"] = boxOf(titleBox) as Any
    entry["timeBox"] = boxOf(timeBox) as Any
    entry["previewBox"] = boxOf(previewBox) as Any
    result.append(entry)
  }
  return result
}

func mouseClick(_ params: [String: Any], button: CGMouseButton) throws -> [String: Any] {
  let point = try point(params)
  try postMouseClick(point, button: button)
  return ["clicked": true, "x": point.x, "y": point.y]
}

func postMouseClick(_ point: CGPoint, button: CGMouseButton) throws {
  let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
  guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else {
    throw HelperError("helper_invalid_response", "Cannot create mouse event")
  }
  let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)
  if let move = move { markSyntheticAutomationEvent(move) }
  markSyntheticAutomationEvent(down)
  markSyntheticAutomationEvent(up)
  move?.post(tap: .cghidEventTap)
  usleep(40_000)
  down.post(tap: .cghidEventTap)
  usleep(120_000)
  up.post(tap: .cghidEventTap)
}

func mouseScroll(_ params: [String: Any]) throws -> [String: Any] {
  let deltaY = Int32(double(params["deltaY"], fallback: double(params["pixels"], fallback: 0)))
  guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: deltaY, wheel2: 0, wheel3: 0) else {
    throw HelperError("helper_invalid_response", "Cannot create scroll event")
  }
  let targetPoint = optionalPoint(params["point"]) ?? optionalPoint(params)
  if let targetPoint = targetPoint {
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: targetPoint, mouseButton: .left) {
      markSyntheticAutomationEvent(move)
      move.post(tap: .cghidEventTap)
      usleep(40_000)
    }
    event.location = targetPoint
  }
  markSyntheticAutomationEvent(event)
  event.post(tap: .cghidEventTap)
  var result: [String: Any] = ["scrolled": true, "deltaY": Int(deltaY)]
  if let targetPoint = targetPoint {
    result["x"] = targetPoint.x
    result["y"] = targetPoint.y
    result["coordinateSpace"] = "screen"
  }
  return result
}

func keyboardType(_ params: [String: Any]) throws -> [String: Any] {
  guard let text = string(params["text"]) else { throw HelperError("helper_invalid_response", "keyboard.type requires text") }
  try postUnicodeText(text)
  return ["typed": true, "strategy": "unicode-events", "characterCount": text.count]
}

func keyboardShortcut(_ params: [String: Any]) throws -> [String: Any] {
  guard let key = string(params["key"]) else { throw HelperError("helper_invalid_response", "keyboard.shortcut requires key") }
  let modifiers = params["modifiers"] as? [String] ?? []
  try postShortcut(key: key, modifiers: modifiers)
  return ["pressed": true, "key": key, "modifiers": modifiers]
}

func postShortcut(key: String, modifiers: [String]) throws {
  guard let keyCode = keyCodeFor(key) else { throw HelperError("helper_invalid_response", "Unsupported key: \(key)") }
  let flags = eventFlags(modifiers)
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    throw HelperError("helper_invalid_response", "Cannot create keyboard event")
  }
  down.flags = flags
  up.flags = flags
  markSyntheticAutomationEvent(down)
  markSyntheticAutomationEvent(up)
  down.post(tap: .cghidEventTap)
  usleep(30_000)
  up.post(tap: .cghidEventTap)
}

func postUnicodeText(_ text: String) throws {
  let units = Array(text.utf16)
  if units.isEmpty { return }
  let chunkSize = 20
  var index = 0
  while index < units.count {
    let end = min(index + chunkSize, units.count)
    let chunk = Array(units[index..<end])
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
      throw HelperError("helper_invalid_response", "Cannot create unicode keyboard event")
    }
    chunk.withUnsafeBufferPointer { buffer in
      down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
    }
    markSyntheticAutomationEvent(down)
    markSyntheticAutomationEvent(up)
    down.post(tap: .cghidEventTap)
    usleep(8_000)
    up.post(tap: .cghidEventTap)
    usleep(12_000)
    index = end
  }
}

func clipboardSnapshot() -> [String: Any] {
  let pasteboard = NSPasteboard.general
  let items = pasteboard.pasteboardItems?.map { item -> [String: Any] in
    var types: [[String: Any]] = []
    for type in item.types {
      if let data = item.data(forType: type) {
        types.append(["type": type.rawValue, "dataBase64": data.base64EncodedString()])
      }
    }
    return ["types": types]
  } ?? []
  return ["changeCount": pasteboard.changeCount, "items": items]
}

func clipboardRestore(_ params: [String: Any]) throws -> [String: Any] {
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  let items = params["items"] as? [[String: Any]] ?? []
  let restoredItems = items.map { item -> NSPasteboardItem in
    let pbItem = NSPasteboardItem()
    let types = item["types"] as? [[String: Any]] ?? []
    for typeInfo in types {
      guard let typeRaw = string(typeInfo["type"]), let base64 = string(typeInfo["dataBase64"]), let data = Data(base64Encoded: base64) else { continue }
      pbItem.setData(data, forType: NSPasteboard.PasteboardType(typeRaw))
    }
    return pbItem
  }
  if !restoredItems.isEmpty { pasteboard.writeObjects(restoredItems) }
  return ["restored": true, "itemCount": restoredItems.count]
}

func clipboardSetText(_ params: [String: Any]) throws -> [String: Any] {
  guard let text = string(params["text"]) else { throw HelperError("helper_invalid_response", "clipboard.setText requires text") }
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  pasteboard.setString(text, forType: .string)
  return ["ok": true, "changeCount": pasteboard.changeCount]
}

func clipboardSetFiles(_ params: [String: Any]) throws -> [String: Any] {
  let raw = params["filePaths"] as? [String] ?? params["paths"] as? [String] ?? []
  let filePaths = raw.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  if filePaths.isEmpty { throw HelperError("helper_invalid_response", "clipboard.setFiles requires filePaths") }
  let urls = filePaths.map { URL(fileURLWithPath: $0) }
  for url in urls {
    if !FileManager.default.fileExists(atPath: url.path) {
      throw HelperError("attachment_unavailable", "Attachment does not exist: \(url.path)")
    }
  }
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  let wrote = pasteboard.writeObjects(urls as [NSURL])
  if let first = urls.first {
    pasteboard.setString(first.absoluteString, forType: .fileURL)
    pasteboard.setString(first.absoluteString, forType: NSPasteboard.PasteboardType("public.file-url"))
  }
  pasteboard.setPropertyList(urls.map { $0.path }, forType: NSPasteboard.PasteboardType("NSFilenamesPboardType"))
  if !wrote { throw HelperError("clipboard_set_files_failed", "Cannot place files on clipboard") }
  return ["ok": true, "fileCount": urls.count, "changeCount": pasteboard.changeCount]
}

func clipboardReadFileUrls() -> [String: Any] {
  let pasteboard = NSPasteboard.general
  let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] ?? []
  var fileUrls = urls.filter { $0.isFileURL }.map { $0.absoluteString }
  var filePaths = urls.filter { $0.isFileURL }.map { $0.path }
  if filePaths.isEmpty,
     let values = pasteboard.propertyList(forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")) as? [String] {
    filePaths = values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    fileUrls = filePaths.map { URL(fileURLWithPath: $0).absoluteString }
  }
  return ["fileUrls": fileUrls, "filePaths": filePaths, "changeCount": pasteboard.changeCount]
}

func clipboardReadAttachment() -> [String: Any] {
  var result = clipboardReadFileUrls()
  let pasteboard = NSPasteboard.general
  let types = pasteboard.types?.map { $0.rawValue } ?? []
  result["types"] = types
  if let filePaths = result["filePaths"] as? [String], !filePaths.isEmpty {
    return result
  }
  let imageTypes: [NSPasteboard.PasteboardType] = [.png, .tiff, NSPasteboard.PasteboardType("public.jpeg")]
  for type in imageTypes {
    guard let data = pasteboard.data(forType: type), !data.isEmpty else { continue }
    if type == .tiff, let image = NSImage(data: data), let pngData = pngDataFromImage(image) {
      result["dataBase64"] = pngData.base64EncodedString()
      result["mimeType"] = "image/png"
      result["suggestedFileName"] = "wechat-image.png"
      return result
    }
    result["dataBase64"] = data.base64EncodedString()
    result["mimeType"] = type == NSPasteboard.PasteboardType("public.jpeg") ? "image/jpeg" : "image/png"
    result["suggestedFileName"] = type == NSPasteboard.PasteboardType("public.jpeg") ? "wechat-image.jpg" : "wechat-image.png"
    return result
  }
  return result
}

func pngDataFromImage(_ image: NSImage) -> Data? {
  guard let tiff = image.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff) else { return nil }
  return rep.representation(using: .png, properties: [:])
}

func menuPickItem(_ params: [String: Any]) throws -> [String: Any] {
  let labels = (params["labels"] as? [String] ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  if labels.isEmpty { throw HelperError("helper_invalid_response", "menu.pickItem requires labels") }
  let disallow = Set((params["disallowLabels"] as? [String] ?? []).map { $0.lowercased() })
  guard AXIsProcessTrusted() else { throw HelperError("permission_accessibility_missing", "Accessibility permission is required to pick menus") }
  let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let roots = [AXUIElementCreateSystemWide(), AXUIElementCreateApplication(pid)]
  for root in roots {
    if let item = findMenuItem(root, labels: labels, disallow: disallow, depth: 0), AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success {
      return ["picked": true, "label": item.label]
    }
  }
  throw HelperError("menu_item_not_found", "Menu item not found: \(labels.joined(separator: "/"))")
}

func findMenuItem(_ element: AXUIElement, labels: [String], disallow: Set<String>, depth: Int) -> (element: AXUIElement, label: String)? {
  if depth > 8 { return nil }
  let role = axString(element, kAXRoleAttribute)
  let title = axString(element, kAXTitleAttribute)
  if role == kAXMenuItemRole as String || role == "AXMenuItem" {
    let folded = title.lowercased()
    if labels.contains(where: { folded == $0.lowercased() || folded.contains($0.lowercased()) }) && !disallow.contains(folded) {
      return (element, title)
    }
  }
  for child in axChildren(element) {
    if let found = findMenuItem(child, labels: labels, disallow: disallow, depth: depth + 1) { return found }
  }
  return nil
}

func findMenuItemInMenu(_ element: AXUIElement, menuLabels: [String], itemLabels: [String], depth: Int = 0) -> (element: AXUIElement, label: String)? {
  if depth > 8 { return nil }
  let title = axString(element, kAXTitleAttribute)
  let role = axString(element, kAXRoleAttribute)
  if role == "AXMenuBarItem",
     menuLabels.contains(where: { title.lowercased() == $0.lowercased() || title.lowercased().contains($0.lowercased()) }) {
    for child in axChildren(element) {
      if let item = findMenuItem(child, labels: itemLabels, disallow: [], depth: 0) {
        return item
      }
    }
  }
  for child in axChildren(element) {
    if let found = findMenuItemInMenu(child, menuLabels: menuLabels, itemLabels: itemLabels, depth: depth + 1) {
      return found
    }
  }
  return nil
}

func savePanelSaveToPath(_ params: [String: Any]) throws -> [String: Any] {
  guard let targetPath = string(params["targetPath"])?.trimmingCharacters(in: .whitespacesAndNewlines), !targetPath.isEmpty else {
    throw HelperError("helper_invalid_response", "savePanel.saveToPath requires targetPath")
  }
  guard AXIsProcessTrusted() else { throw HelperError("permission_accessibility_missing", "Accessibility permission is required to drive save panels") }

  let targetUrl = URL(fileURLWithPath: targetPath)
  let parentUrl = targetUrl.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: parentUrl, withIntermediateDirectories: true)
  if bool(params["overwrite"]), FileManager.default.fileExists(atPath: targetUrl.path) {
    try? FileManager.default.removeItem(at: targetUrl)
  }

  let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  guard pid > 0 else { throw HelperError("save_panel_app_missing", "Cannot find frontmost application for save panel") }
  let axApp = AXUIElementCreateApplication(pid)
  guard let panel = waitForSavePanel(axApp: axApp, timeoutMs: 4000) else {
    throw HelperError("save_panel_not_found", "Cannot find macOS save panel")
  }

  try navigateSavePanel(toDirectory: parentUrl.path)
  usleep(350_000)
  guard let refreshedPanel = waitForSavePanel(axApp: axApp, timeoutMs: 2500) ?? Optional(panel) else {
    throw HelperError("save_panel_not_found", "Cannot refocus macOS save panel")
  }
  try setSavePanelFileName(refreshedPanel, fileName: targetUrl.lastPathComponent)
  usleep(120_000)
  try pressSavePanelButton(refreshedPanel)
  try confirmSavePanelReplaceIfNeeded(axApp: axApp)

  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline {
    if let attrs = try? FileManager.default.attributesOfItem(atPath: targetUrl.path),
       let size = attrs[.size] as? NSNumber,
       size.int64Value > 0 {
      return ["filePath": targetUrl.path, "size": size.int64Value]
    }
    usleep(150_000)
  }
  throw HelperError("save_panel_file_missing", "Save panel completed but the target file was not created")
}

func waitForSavePanel(axApp: AXUIElement, timeoutMs: Int) -> AXUIElement? {
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
  while Date() < deadline {
    if let panel = findSavePanel(axApp, depth: 0) { return panel }
    usleep(120_000)
  }
  return nil
}

func findSavePanel(_ element: AXUIElement, depth: Int) -> AXUIElement? {
  if depth > 8 { return nil }
  let role = axString(element, kAXRoleAttribute)
  let title = axString(element, kAXTitleAttribute)
  if role == kAXWindowRole as String || role == "AXSheet" || role == "AXDialog" {
    let folded = title.lowercased()
    if folded.contains("save") || folded.contains("保存") || folded.contains("存储") || containsButton(element, labels: ["保存", "存储", "Save"]) {
      return element
    }
  }
  for child in axChildren(element) {
    if let found = findSavePanel(child, depth: depth + 1) { return found }
  }
  return nil
}

func navigateSavePanel(toDirectory directory: String) throws {
  try postShortcut(key: "g", modifiers: ["command", "shift"])
  usleep(250_000)
  try clipboardSetText(["text": directory])
  try postShortcut(key: "v", modifiers: ["command"])
  usleep(80_000)
  try postShortcut(key: "return", modifiers: [])
}

func setSavePanelFileName(_ panel: AXUIElement, fileName: String) throws {
  guard let field = findBestSaveNameField(panel) else {
    throw HelperError("save_panel_filename_field_missing", "Cannot find save panel file name field")
  }
  AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if let rect = axFrame(field) {
    try postMouseClick(CGPoint(x: rect.midX, y: rect.midY), button: .left)
  }
  usleep(80_000)
  _ = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, fileName as CFString)
  try clipboardSetText(["text": fileName])
  try postShortcut(key: "a", modifiers: ["command"])
  usleep(40_000)
  try postShortcut(key: "v", modifiers: ["command"])
}

func findBestSaveNameField(_ panel: AXUIElement) -> AXUIElement? {
  let fields = collectTextFields(panel, depth: 0)
  if fields.isEmpty { return nil }
  let sorted = fields.sorted { left, right in
    let leftFrame = axFrame(left) ?? .zero
    let rightFrame = axFrame(right) ?? .zero
    if abs(leftFrame.minY - rightFrame.minY) > 1 { return leftFrame.minY < rightFrame.minY }
    return leftFrame.width > rightFrame.width
  }
  return sorted.first
}

func collectTextFields(_ element: AXUIElement, depth: Int) -> [AXUIElement] {
  if depth > 8 { return [] }
  let role = axString(element, kAXRoleAttribute)
  var result: [AXUIElement] = []
  if role == kAXTextFieldRole as String || role == "AXTextField" {
    result.append(element)
  }
  for child in axChildren(element) {
    result.append(contentsOf: collectTextFields(child, depth: depth + 1))
  }
  return result
}

func pressSavePanelButton(_ panel: AXUIElement) throws {
  if let button = findButton(panel, labels: ["保存", "存储", "Save"], depth: 0),
     AXUIElementPerformAction(button.element, kAXPressAction as CFString) == .success {
    return
  }
  try postShortcut(key: "return", modifiers: [])
}

func confirmSavePanelReplaceIfNeeded(axApp: AXUIElement) throws {
  let deadline = Date().addingTimeInterval(1.5)
  while Date() < deadline {
    if let button = findButton(axApp, labels: ["替换", "Replace"], depth: 0),
       AXUIElementPerformAction(button.element, kAXPressAction as CFString) == .success {
      return
    }
    usleep(120_000)
  }
}

func containsButton(_ element: AXUIElement, labels: [String]) -> Bool {
  return findButton(element, labels: labels, depth: 0) != nil
}

func findButton(_ element: AXUIElement, labels: [String], depth: Int) -> (element: AXUIElement, label: String)? {
  if depth > 8 { return nil }
  let role = axString(element, kAXRoleAttribute)
  let title = axString(element, kAXTitleAttribute)
  if role == kAXButtonRole as String || role == "AXButton" {
    let folded = title.lowercased()
    if labels.contains(where: { folded == $0.lowercased() || folded.contains($0.lowercased()) }) {
      return (element, title)
    }
  }
  for child in axChildren(element) {
    if let found = findButton(child, labels: labels, depth: depth + 1) { return found }
  }
  return nil
}

func imageCropHash(_ params: [String: Any]) throws -> [String: Any] {
  let decoded = try decodeImage(params)
  let bbox = params["bbox"] as? [String: Any] ?? params["rect"] as? [String: Any] ?? [:]
  let rect = CGRect(
    x: max(0, double(bbox["x"])),
    y: max(0, double(bbox["y"])),
    width: max(1, double(bbox["width"], fallback: Double(decoded.width))),
    height: max(1, double(bbox["height"], fallback: Double(decoded.height)))
  ).intersection(CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
  guard !rect.isNull, let crop = decoded.image.cropping(to: rect) else {
    throw HelperError("helper_invalid_response", "Cannot crop image")
  }
  let rep = NSBitmapImageRep(cgImage: crop)
  guard let png = rep.representation(using: .png, properties: [:]) else {
    throw HelperError("helper_invalid_response", "Cannot encode cropped image")
  }
  let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
  var result: [String: Any] = ["hash": digest, "algorithm": "sha256-png", "width": crop.width, "height": crop.height]
  if bool(params["includeDataBase64"]) {
    result["mimeType"] = "image/png"
    result["dataBase64"] = png.base64EncodedString()
  }
  return result
}

func wechatSearchConversation(_ params: [String: Any]) throws -> [String: Any] {
  let text = (string(params["conversationName"]) ?? string(params["text"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty {
    throw HelperError("helper_invalid_response", "wechat.searchConversation requires conversationName or text")
  }
  let targetWindowId = string(params["windowId"])
  if let targetWindowId {
    _ = try focusWindow(["windowId": targetWindowId])
  } else {
    _ = try ensureWeChatWindowReady(["restore": true, "focus": true])
  }
  guard let app = findWeChatRunningApplication() else {
    throw HelperError("wechat_not_running", "WeChat is not running")
  }
  _ = activateWeChatApplication(app)
  noteAutomationLeaseExpectedFrontmostApp(app)

  try? postShortcut(key: "escape", modifiers: [])
  usleep(120_000)

  let explicitPoint = explicitSearchPoint(params)
  let strategy: String
  if let explicitPoint {
    strategy = "explicit-search-point"
    try postMouseClick(explicitPoint, button: .left)
    usleep(160_000)
  } else if let fallbackPoint = fallbackWeChatSearchPoint(windowId: targetWindowId) {
    strategy = "fallback-search-click"
    try postMouseClick(fallbackPoint, button: .left)
    usleep(160_000)
  } else {
    throw HelperError("wechat_search_field_not_found", "Cannot find WeChat search field")
  }
  usleep(220_000)

  try postShortcut(key: "a", modifiers: ["command"])
  usleep(60_000)
  try? postShortcut(key: "backspace", modifiers: [])
  usleep(80_000)
  try clipboardSetText(["text": text])
  try postShortcut(key: "v", modifiers: ["command"])

  let waitMs = max(0, min(3000, Int(double(params["waitMs"], fallback: 700))))
  usleep(useconds_t(waitMs * 1000))
  var result: [String: Any] = ["searched": true, "conversationName": text, "strategy": strategy]
  return result
}

func wechatFocusMessageInput(_ params: [String: Any]) throws -> [String: Any] {
  let targetWindowId = string(params["windowId"])
  if let targetWindowId {
    _ = try focusWindow(["windowId": targetWindowId])
  } else {
    _ = try ensureWeChatWindowReady(["restore": true, "focus": true])
  }
  guard let app = findWeChatRunningApplication() else {
    throw HelperError("wechat_not_running", "WeChat is not running")
  }
  _ = activateWeChatApplication(app)
  noteAutomationLeaseExpectedFrontmostApp(app)
  usleep(120_000)

  let explicitPoint = explicitInputPoint(params)
  let point: CGPoint
  let strategy: String
  if let explicitPoint {
    point = explicitPoint
    strategy = "explicit-input-point"
  } else if let fallbackPoint = fallbackWeChatMessageInputPoint(windowId: targetWindowId) {
    point = fallbackPoint
    strategy = "fallback-input-click"
  } else {
    throw HelperError("wechat_message_input_not_found", "Cannot find WeChat message input")
  }
  try postMouseClick(point, button: .left)
  let waitMs = max(0, min(1500, Int(double(params["waitMs"], fallback: 180))))
  usleep(useconds_t(waitMs * 1000))
  var result: [String: Any] = [
    "focused": true,
    "x": point.x,
    "y": point.y,
    "strategy": strategy,
    "point": ["x": point.x, "y": point.y, "coordinateSpace": "screen"],
  ]
  if let window = weChatWindowMetadata(windowId: targetWindowId) {
    result["window"] = window
  }
  return result
}

func decodeImage(_ params: [String: Any]) throws -> (image: CGImage, width: Int, height: Int) {
  guard let base64 = string(params["dataBase64"]), let data = Data(base64Encoded: base64) else {
    throw HelperError("helper_invalid_response", "Image dataBase64 is required")
  }
  guard let image = NSImage(data: data), let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    throw HelperError("helper_invalid_response", "Cannot decode image")
  }
  let width = Int(params["width"] as? Int ?? cgImage.width)
  let height = Int(params["height"] as? Int ?? cgImage.height)
  return (cgImage, width, height)
}

func cgWindowId(_ params: [String: Any]) throws -> CGWindowID {
  guard let raw = string(params["windowId"]), let value = UInt32(raw) else {
    throw HelperError("helper_invalid_response", "windowId is required")
  }
  return CGWindowID(value)
}

func ownerPid(windowId: CGWindowID) -> pid_t? {
  let raw = listWindows(includeOffscreen: true)
  guard let item = raw.first(where: { ($0["windowId"] as? String) == String(windowId) }),
        let pid = item["ownerPid"] as? Int32 else {
    return ownerPidFromCgWindow(windowId: windowId)
  }
  return pid_t(pid)
}

func windowBounds(windowId: CGWindowID) -> CGRect? {
  let raw = listWindows(includeOffscreen: true)
  guard let item = raw.first(where: { ($0["windowId"] as? String) == String(windowId) }),
        let rect = rectFromWindowInfo(item) else { return nil }
  return rect
}

func ownerPidFromCgWindow(windowId: CGWindowID) -> pid_t? {
  guard let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for item in raw {
    guard let number = item[kCGWindowNumber as String] as? UInt32, number == windowId,
          let pid = item[kCGWindowOwnerPID as String] as? Int32 else { continue }
    return pid_t(pid)
  }
  return nil
}

func rectFromWindowInfo(_ window: [String: Any]) -> CGRect? {
  guard let bounds = window["bounds"] as? [String: Any] else { return nil }
  let x = double(bounds["x"])
  let y = double(bounds["y"])
  let width = double(bounds["width"])
  let height = double(bounds["height"])
  guard width > 0, height > 0 else { return nil }
  return CGRect(x: x, y: y, width: width, height: height)
}

func rectIntersectsAnyDisplay(_ rect: CGRect) -> Bool {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
  var displays = Array<CGDirectDisplayID>(repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
  return displays.prefix(Int(count)).contains { display in
    rect.intersects(CGDisplayBounds(display))
  }
}

func findWeChatRunningApplication() -> NSRunningApplication? {
  return NSWorkspace.shared.runningApplications.first { app in
    let name = (app.localizedName ?? "").lowercased()
    let bundle = (app.bundleIdentifier ?? "").lowercased()
    return name.contains("wechat") || name.contains("微信") || bundle.contains("wechat") || bundle.contains("xinwechat")
  }
}

func isWeChatApplicationName(_ value: String?) -> Bool {
  let name = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return name.contains("wechat") || name.contains("微信")
}

func hideSystemPermissionObstructions() {
  for app in NSWorkspace.shared.runningApplications {
    let name = (app.localizedName ?? "").lowercased()
    let bundle = (app.bundleIdentifier ?? "").lowercased()
    let isSettings = bundle == "com.apple.systempreferences" || bundle == "com.apple.systemsettings" || name.contains("系统设置") || name.contains("system settings")
    let isPermissionAlert = name.contains("universalauth") || name.contains("accessauth") || name.contains("permission")
    if isSettings || isPermissionAlert {
      app.hide()
    }
  }
}

func activateWeChatApplication(_ app: NSRunningApplication) -> Bool {
  return app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
}

func weChatAppleScriptTarget() -> String {
  if let bundleId = findWeChatRunningApplication()?.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
     !bundleId.isEmpty {
    return "application id \"\(appleScriptEscaped(bundleId))\""
  }
  return "application \"WeChat\""
}

func appleScriptEscaped(_ value: String) -> String {
  return value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
}

func raiseAXApp(pid: pid_t, windowId: CGWindowID? = nil) {
  guard AXIsProcessTrusted() else { return }
  let axApp = AXUIElementCreateApplication(pid)
  AXUIElementPerformAction(axApp, kAXRaiseAction as CFString)
  for window in axWindows(axApp) {
    AXUIElementSetAttributeValue(window, "AXMinimized" as CFString, kCFBooleanFalse)
  }
  let target = windowId.flatMap { findWindowByCgWindowId(axApp, windowId: $0, depth: 0) } ?? axWindows(axApp).first
  if let target {
    AXUIElementSetAttributeValue(target, "AXMinimized" as CFString, kCFBooleanFalse)
    AXUIElementPerformAction(target, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  }
}

func repositionPrimaryAXWindow(pid: pid_t, windowId: String?) {
  guard AXIsProcessTrusted() else { return }
  let axApp = AXUIElementCreateApplication(pid)
  let targetWindowId = windowId.flatMap { UInt32($0) }
  let target = targetWindowId.flatMap { id in findWindowByCgWindowId(axApp, windowId: CGWindowID(id), depth: 0) } ?? axWindows(axApp).first
  guard let target else { return }
  if let current = axFrame(target) {
    setAXWindowFrame(target, frame: clampWindowToVisibleFrame(current))
    AXUIElementPerformAction(target, kAXRaiseAction as CFString)
  }
}

func setAXWindowFrame(_ window: AXUIElement, frame: CGRect) {
  var origin = frame.origin
  var size = frame.size
  if let position = AXValueCreate(.cgPoint, &origin) {
    AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
  }
  if let axSize = AXValueCreate(.cgSize, &size) {
    AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, axSize)
  }
}

func clampWindowToVisibleFrame(_ frame: CGRect) -> CGRect {
  let visible = primaryVisibleFrame()
  let fallbackWidth = min(max(visible.width - 40, 320), 900)
  let fallbackHeight = min(max(visible.height - 40, 320), 720)
  if frame.isNull {
    return CGRect(x: visible.minX + 24, y: visible.minY + 24, width: fallbackWidth, height: fallbackHeight)
  }
  let width = min(frame.width > 0 ? frame.width : 900, max(320, visible.width - 40))
  let height = min(frame.height > 0 ? frame.height : 720, max(320, visible.height - 40))
  let x = min(max(frame.minX, visible.minX + 24), visible.maxX - width - 16)
  let y = min(max(frame.minY, visible.minY + 24), visible.maxY - height - 16)
  return CGRect(x: x, y: y, width: width, height: height)
}

func primaryVisibleFrame() -> CGRect {
  return NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
}

func findWeChatSearchField(_ app: AXUIElement) -> AXUIElement? {
  return findWeChatSearchField(app, depth: 0)
}

func findWeChatSearchField(_ element: AXUIElement, depth: Int) -> AXUIElement? {
  if depth > 10 { return nil }
  let itemRole = axString(element, kAXRoleAttribute)
  if ["AXSearchField", "AXTextField"].contains(itemRole), let rect = axFrame(element) {
    if rect.width >= 80 && rect.height >= 16 && rect.minY < 360 {
      return element
    }
  }
  for child in axChildren(element) {
    if let found = findWeChatSearchField(child, depth: depth + 1) { return found }
  }
  return nil
}

func fallbackWeChatSearchPoint(windowId: String?) -> CGPoint? {
  guard let window = weChatWindowMetadata(windowId: windowId),
        let bounds = window["bounds"] as? [String: Any] else { return nil }
  let x = double(bounds["x"])
  let y = double(bounds["y"])
  let width = double(bounds["width"])
  let height = double(bounds["height"])
  guard width > 0, height > 0 else { return nil }
  return CGPoint(
    x: x + min(max(width * 0.20, 120), 260),
    y: y + min(max(height * 0.045, 36), 72)
  )
}

func fallbackWeChatMessageInputPoint(windowId: String?) -> CGPoint? {
  guard let window = weChatWindowMetadata(windowId: windowId),
        let bounds = window["bounds"] as? [String: Any] else { return nil }
  let x = double(bounds["x"])
  let y = double(bounds["y"])
  let width = double(bounds["width"])
  let height = double(bounds["height"])
  guard width > 0, height > 0 else { return nil }
  let xOffset = max(520, min(width - 160, width * 0.68))
  let bottomInset = max(48, min(88, height * 0.08))
  return CGPoint(x: x + xOffset, y: y + height - bottomInset)
}

func weChatWindowMetadata(windowId: String?) -> [String: Any]? {
  let windows = listWindows().filter { item in
    isWeChatWindow(item)
  }
  if let windowId, let matched = windows.first(where: { ($0["windowId"] as? String) == windowId }) {
    return matched
  }
  return windows.first
}

func explicitSearchPoint(_ params: [String: Any]) -> CGPoint? {
  if let raw = params["searchPoint"] as? [String: Any] {
    let x = double(raw["x"], fallback: .nan)
    let y = double(raw["y"], fallback: .nan)
    if x.isFinite && y.isFinite { return CGPoint(x: x, y: y) }
  }
  let x = double(params["x"], fallback: .nan)
  let y = double(params["y"], fallback: .nan)
  if x.isFinite && y.isFinite { return CGPoint(x: x, y: y) }
  return nil
}

func explicitInputPoint(_ params: [String: Any]) -> CGPoint? {
  if let raw = params["inputPoint"] as? [String: Any] {
    let x = double(raw["x"], fallback: .nan)
    let y = double(raw["y"], fallback: .nan)
    if x.isFinite && y.isFinite { return CGPoint(x: x, y: y) }
  }
  return nil
}

func point(_ params: [String: Any]) throws -> CGPoint {
  let x = double(params["x"], fallback: .nan)
  let y = double(params["y"], fallback: .nan)
  if !x.isFinite || !y.isFinite { throw HelperError("helper_invalid_response", "x/y point is required") }
  return CGPoint(x: x, y: y)
}

func optionalPoint(_ value: Any?) -> CGPoint? {
  guard let raw = value as? [String: Any] else { return nil }
  let x = double(raw["x"], fallback: .nan)
  let y = double(raw["y"], fallback: .nan)
  guard x.isFinite, y.isFinite else { return nil }
  return CGPoint(x: x, y: y)
}

func rectFromParams(_ value: Any?) -> CGRect? {
  guard let raw = value as? [String: Any] else { return nil }
  let x = double(raw["x"], fallback: .nan)
  let y = double(raw["y"], fallback: .nan)
  let width = double(raw["width"], fallback: .nan)
  let height = double(raw["height"], fallback: .nan)
  guard x.isFinite, y.isFinite, width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
  return CGRect(x: x, y: y, width: width, height: height)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return [] }
  return value as? [AXUIElement] ?? []
}

func axWindows(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success else { return [] }
  return value as? [AXUIElement] ?? []
}

func findWindowByCgWindowId(_ element: AXUIElement, windowId: CGWindowID, depth: Int) -> AXUIElement? {
  if depth > 8 { return nil }
  let role = axString(element, kAXRoleAttribute)
  if role == kAXWindowRole as String || role == "AXWindow" {
    var numberValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, "AXWindowNumber" as CFString, &numberValue) == .success,
       let number = numberValue as? NSNumber,
       number.uint32Value == UInt32(windowId) {
      return element
    }
  }
  for child in axChildren(element) + axWindows(element) {
    if let found = findWindowByCgWindowId(child, windowId: windowId, depth: depth + 1) { return found }
  }
  return nil
}

func axString(_ element: AXUIElement, _ attr: String) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return "" }
  return value as? String ?? ""
}

func axFrame(_ element: AXUIElement) -> CGRect? {
  var positionValue: CFTypeRef?
  var sizeValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let position = positionValue,
        let size = sizeValue else { return nil }
  var point = CGPoint.zero
  var rectSize = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
        AXValueGetValue(size as! AXValue, .cgSize, &rectSize) else { return nil }
  return CGRect(origin: point, size: rectSize)
}

func eventFlags(_ modifiers: [String]) -> CGEventFlags {
  var flags = CGEventFlags()
  for modifier in modifiers.map({ $0.lowercased() }) {
    if modifier == "command" || modifier == "cmd" || modifier == "meta" { flags.insert(.maskCommand) }
    if modifier == "control" || modifier == "ctrl" { flags.insert(.maskControl) }
    if modifier == "option" || modifier == "alt" { flags.insert(.maskAlternate) }
    if modifier == "shift" { flags.insert(.maskShift) }
  }
  return flags
}

func keyCodeFor(_ raw: String) -> CGKeyCode? {
  switch raw.lowercased() {
  case "a": return 0
  case "s": return 1
  case "d": return 2
  case "f": return 3
  case "h": return 4
  case "g": return 5
  case "z": return 6
  case "x": return 7
  case "c": return 8
  case "v": return 9
  case "b": return 11
  case "q": return 12
  case "w": return 13
  case "e": return 14
  case "r": return 15
  case "y": return 16
  case "t": return 17
  case "1": return 18
  case "2": return 19
  case "3": return 20
  case "4": return 21
  case "6": return 22
  case "5": return 23
  case "=", "+": return 24
  case "9": return 25
  case "7": return 26
  case "-": return 27
  case "8": return 28
  case "0": return 29
  case "]": return 30
  case "o": return 31
  case "u": return 32
  case "[": return 33
  case "i": return 34
  case "p": return 35
  case "return", "enter": return 36
  case "l": return 37
  case "j": return 38
  case "'": return 39
  case "k": return 40
  case ";": return 41
  case "\\": return 42
  case ",": return 43
  case "/": return 44
  case "n": return 45
  case "m": return 46
  case ".": return 47
  case "tab": return 48
  case "space": return 49
  case "escape", "esc": return 53
  case "delete", "backspace": return 51
  case "home": return 115
  case "end": return 119
  case "pageup", "page_up": return 116
  case "pagedown", "page_down": return 121
  case "left": return 123
  case "right": return 124
  case "down": return 125
  case "up": return 126
  default: return nil
  }
}

func string(_ value: Any?) -> String? {
  if let value = value as? String { return value }
  if let value = value { return String(describing: value) }
  return nil
}

func double(_ value: Any?, fallback: Double = 0) -> Double {
  if let value = value as? Double { return value }
  if let value = value as? Int { return Double(value) }
  if let value = value as? NSNumber { return value.doubleValue }
  if let value = value as? String, let parsed = Double(value) { return parsed }
  return fallback
}

func bool(_ value: Any?) -> Bool {
  if let value = value as? Bool { return value }
  if let value = value as? NSNumber { return value.boolValue }
  if let value = value as? String {
    let folded = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return ["1", "true", "yes", "y"].contains(folded)
  }
  return false
}

func bool(_ value: Any?, fallback: Bool) -> Bool {
  if value == nil { return fallback }
  return bool(value)
}

if CommandLine.arguments.contains("--request-screen-recording") {
  writeJSON([
    "ok": true,
    "result": requestScreenRecordingPermission(),
  ])
  Thread.sleep(forTimeInterval: 2)
  exit(0)
}

if CommandLine.arguments.contains("--request-accessibility") {
  writeJSON([
    "ok": true,
    "result": requestAccessibilityPermission(),
  ])
  Thread.sleep(forTimeInterval: 2)
  exit(0)
}

if CommandLine.arguments.contains("--request-input-monitoring") {
  writeJSON([
    "ok": true,
    "result": requestInputMonitoringPermission(),
  ])
  Thread.sleep(forTimeInterval: 2)
  exit(0)
}

final class FileHandleLineReader {
  private let handle: FileHandle
  private let fd: Int32
  private var buffer = Data()

  init(_ handle: FileHandle) {
    self.handle = handle
    self.fd = handle.fileDescriptor
  }

  func readLine() -> String? {
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      if let newlineIndex = buffer.firstIndex(of: 10) {
        var line = buffer[..<newlineIndex]
        if line.last == 13 { line = line.dropLast() }
        buffer.removeSubrange(...newlineIndex)
        return String(data: line, encoding: .utf8)
      }
      let count = chunk.withUnsafeMutableBytes { rawBuffer -> Int in
        guard let base = rawBuffer.baseAddress else { return -1 }
        return Darwin.read(fd, base, rawBuffer.count)
      }
      if count == 0 {
        if buffer.isEmpty { return nil }
        let line = buffer
        buffer.removeAll(keepingCapacity: false)
        return String(data: line, encoding: .utf8)
      }
      if count < 0 {
        if errno == EINTR { continue }
        return nil
      }
      buffer.append(contentsOf: chunk.prefix(count))
    }
  }
}

func commandLineValue(after flag: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: flag),
        CommandLine.arguments.count > index + 1 else {
    return nil
  }
  return CommandLine.arguments[index + 1]
}

func defaultSocketRuntimeDir() -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return (home as NSString).appendingPathComponent("Library/Application Support/Shennian/Helper")
}

func isRunningFromAppBundle() -> Bool {
  Bundle.main.bundlePath.hasSuffix(".app")
}

func shouldStartSocketRuntime() -> Bool {
  if CommandLine.arguments.contains("--socket-runtime") { return true }
  if !isRunningFromAppBundle() { return false }
  let appLaunchArguments = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
  return appLaunchArguments.isEmpty
}

func startSocketRuntime(runtimeDir: String) throws {
  let manager = FileManager.default
  try manager.createDirectory(atPath: runtimeDir, withIntermediateDirectories: true)
  _ = runtimeDir.withCString { chmod($0, S_IRWXU) }

  let socketPath = (runtimeDir as NSString).appendingPathComponent("runtime.sock")
  let runtimeFile = (runtimeDir as NSString).appendingPathComponent("runtime.json")
  try? manager.removeItem(atPath: socketPath)

  let serverFd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard serverFd >= 0 else {
    throw HelperError("helper_socket_unavailable", "Cannot create runtime socket: errno \(errno)")
  }

  do {
    try bindUnixSocket(serverFd: serverFd, socketPath: socketPath)
    guard Darwin.listen(serverFd, 16) == 0 else {
      throw HelperError("helper_socket_listen_failed", "Cannot listen on runtime socket: errno \(errno)")
    }
    _ = socketPath.withCString { chmod($0, S_IRUSR | S_IWUSR) }
    try writeSocketRuntimeFile(runtimeFile: runtimeFile, socketPath: socketPath)
  } catch {
    Darwin.close(serverFd)
    throw error
  }

  let thread = Thread(block: {
    acceptSocketClients(serverFd: serverFd)
  })
  thread.name = "shennian-wechat-helper-socket"
  thread.start()
}

func bindUnixSocket(serverFd: Int32, socketPath: String) throws {
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8CString)
  let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
  guard pathBytes.count <= maxPathLength else {
    throw HelperError("helper_socket_path_too_long", "Runtime socket path is too long")
  }
  withUnsafeMutablePointer(to: &address.sun_path) { pointer in
    pointer.withMemoryRebound(to: CChar.self, capacity: maxPathLength) { buffer in
      for index in 0..<maxPathLength { buffer[index] = 0 }
      for index in 0..<pathBytes.count { buffer[index] = pathBytes[index] }
    }
  }
  let result = withUnsafePointer(to: &address) { pointer -> Int32 in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      Darwin.bind(serverFd, socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard result == 0 else {
    throw HelperError("helper_socket_bind_failed", "Cannot bind runtime socket: errno \(errno)")
  }
}

func writeSocketRuntimeFile(runtimeFile: String, socketPath: String) throws {
  let payload: [String: Any] = [
    "pid": Int(ProcessInfo.processInfo.processIdentifier),
    "socketPath": socketPath,
    "helperVersion": helperVersion,
    "protocolVersion": protocolVersion,
    "startedAt": iso(Date()),
  ]
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: runtimeFile), options: .atomic)
  _ = runtimeFile.withCString { chmod($0, S_IRUSR | S_IWUSR) }
}

func acceptSocketClients(serverFd: Int32) {
  while true {
    let clientFd = Darwin.accept(serverFd, nil, nil)
    if clientFd < 0 {
      if errno == EINTR { continue }
      Thread.sleep(forTimeInterval: 0.1)
      continue
    }
    let thread = Thread(block: {
      autoreleasepool {
        let handle = FileHandle(fileDescriptor: clientFd, closeOnDealloc: true)
        let reader = FileHandleLineReader(handle)
        runJsonRpcLoop(warmupBeforeReading: false, output: handle) { reader.readLine() }
        try? handle.close()
      }
    })
    thread.name = "shennian-wechat-helper-client"
    thread.start()
  }
}

func runJsonRpcLoop(warmupBeforeReading: Bool = true, output: FileHandle? = nil, _ readNextLine: () -> String?) {
  if warmupBeforeReading {
    warmupVision()
  }
  while let line = readNextLine() {
    guard let frame = readFrame(line) else { continue }
    if string(frame["type"]) == "hello" {
      if !warmupBeforeReading {
        startWarmupVisionInBackground()
      }
      let expected = string(frame["expectedHelperVersion"])
      writeJSON(readyFrame(expectedVersion: expected), to: output)
      continue
    }
    writeJSON(handleCommand(frame), to: output)
  }
}

if let fifoIndex = CommandLine.arguments.firstIndex(of: "--stdio-fifo"),
   CommandLine.arguments.count > fifoIndex + 2 {
  let inputPath = CommandLine.arguments[fifoIndex + 1]
  let outputPath = CommandLine.arguments[fifoIndex + 2]
  guard let input = openFifoReadWrite(inputPath),
        let output = openFifoReadWrite(outputPath) else {
    exit(2)
  }
  jsonOutput = output
  let reader = FileHandleLineReader(input)
  runJsonRpcLoop { reader.readLine() }
  exit(0)
}

if shouldStartSocketRuntime() {
  let runtimeDir = commandLineValue(after: "--socket-runtime") ?? defaultSocketRuntimeDir()
  do {
    try startSocketRuntime(runtimeDir: runtimeDir)
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.finishLaunching()
    NSApplication.shared.run()
  } catch {
    writeJSON([
      "ok": false,
      "errorCode": errorCode(error),
      "errorSummary": errorSummary(error),
    ])
    exit(3)
  }
}

runJsonRpcLoop { readLine(strippingNewline: true) }

func openFifoReadWrite(_ path: String) -> FileHandle? {
  let fd = open(path, O_RDWR)
  if fd < 0 { return nil }
  return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}
