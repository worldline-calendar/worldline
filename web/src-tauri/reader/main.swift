// worldline-reader: reads a pasted or dropped document with the language model built into macOS 26 (Apple
// Foundation Models: on this device, no network, no account) and lists what a person would add to a calendar.
//
// The model does the reading: what is a plan and what is noise, what the title is, which date words belong to
// which thing, what a reply changed. It does not do date arithmetic: it copies each date as written ("Wednesday,
// December 2, 12–1 pm", "tomorrow at 4"), and the app's own date reader turns those into times.
//
// It answers in plain lines ("event | Dentist | Tuesday Dec 8 at 3pm | Bloor Dental | "), not a schema: Apple's
// permissive guardrails — the ones meant for transforming text the user gave, so a dentist appointment or a court
// date isn't refused as "sensitive" — apply only to plain-text answers.
//
// stdin:  {"text": "...", "today": "Monday, November 23, 2026"}
// stdout: {"available": true, "items": [{"kind": "event", "title": "...", "when": "...", ...}]}
//         {"available": false, "reason": "..."}            (Apple Intelligence off, unsupported Mac, …)
import Foundation
import FoundationModels
import Vision

struct Input: Decodable { let text: String; let today: String; var candidates: [String]? = nil }
struct OutItem: Encodable { let kind, title, when, location, repeats: String }
struct Output: Encodable { let available: Bool; var reason: String? = nil; var items: [OutItem] = []; var keep: [Bool]? = nil; var text: String? = nil }

func emit(_ o: Output) {
  let data = try! JSONEncoder().encode(o)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

let instructions = """
  You read emails, text-message threads, letters, newsletters, schedules and booking confirmations, and list what \
  the reader should put on their calendar: future appointments, meetings, classes, shifts, trips and parties \
  (event); things due by a date such as forms, payments, submissions, RSVPs and registrations (deadline); and \
  things to do or bring (task).

  Answer with one line per item and nothing else, in this form:
  kind | title | when | location | repeats

  kind: event, deadline or task.
  title: a short calendar title, 2 to 7 words, as a person would type it. No date or time in it.
  when: the date and the time words (start and end time too) copied exactly from the text, so they stand on their own ("Wednesday, December 2, \
  12–1 pm", "tomorrow at 4pm", "Dec 21 – Jan 1"). Never work out a date yourself and never add a weekday or a year \
  that the text doesn't say. If a later message changed the day or time, write the final one. Leave it empty for a \
  task with no day.
  location: the place or room if one is named, else empty.
  repeats: how it repeats in words ("every Tuesday and Thursday", "weekly until Jan 27"), else empty.

  Leave out: things that already happened, cancelled things, when a message was sent, office hours, policies \
  ("returns within 30 days"), prices, tracking numbers and marketing. Each item once. Quoted replies (lines starting \
  with ">") are earlier messages: use them for context; the newest message wins. If there is nothing, answer NONE.

  Only list what the text itself states as planned. A greeting, a signature, a sent date or advice is not an item. \
  Do not make up to-dos.

  Example text: "Reminder: the board meeting is on Tuesday, March 3 from 9:30 to 11 in Room 4. Expense reports are \
  due by March 6."
  Example answer:
  event | Board meeting | Tuesday, March 3 from 9:30 to 11 | Room 4 |
  deadline | Expense reports | by March 6 | |
  """

// The model's window is about 4,000 tokens: long documents are read a few paragraphs at a time.
func chunks(_ text: String, size: Int = 5000) -> [String] {
  if text.count <= size { return [text] }
  var out: [String] = [], cur = ""
  for para in text.components(separatedBy: "\n\n") {
    if cur.count + para.count > size, !cur.isEmpty { out.append(cur); cur = "" }
    cur += (cur.isEmpty ? "" : "\n\n") + String(para.prefix(size))
  }
  if !cur.isEmpty { out.append(cur) }
  return Array(out.prefix(8))
}

/** "event | Dentist | Tuesday Dec 8 at 3pm | Bloor Dental |" → an item; anything else (chatter, NONE) is skipped. */
func parseLine(_ line: String) -> OutItem? {
  let f = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
  guard f.count >= 3 else { return nil }
  let kind = f[0].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "-*• "))
  guard ["event", "deadline", "task"].contains(kind), !f[1].isEmpty else { return nil }
  let at = { (i: Int) in f.count > i ? f[i] : "" }
  return OutItem(kind: kind, title: f[1], when: at(2), location: at(3), repeats: at(4))
}

let raw = FileHandle.standardInput.readDataToEndOfFile()

// `worldline-reader ocr`: stdin is an image (a screenshot of a booking, a photo of a poster); stdout {"available":
// true, "text": "..."}, its words line by line, top to bottom, read by the Mac's own text recognition (Vision).
if CommandLine.arguments.dropFirst().first == "ocr" {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  do {
    try VNImageRequestHandler(data: raw, options: [:]).perform([request])
    // pieces into lines: ones whose middles are level with each other are one line, left to right
    let pieces = (request.results ?? []).compactMap { o -> (String, CGRect)? in
      guard let t = o.topCandidates(1).first?.string else { return nil }
      return (t, o.boundingBox)
    }.sorted { $0.1.midY > $1.1.midY }
    var lines: [[(String, CGRect)]] = []
    for p in pieces {
      if let last = lines.last?.first, abs(last.1.midY - p.1.midY) < min(last.1.height, p.1.height) / 2 { lines[lines.count - 1].append(p) } else { lines.append([p]) }
    }
    let text = lines.map { $0.sorted { $0.1.minX < $1.1.minX }.map { $0.0 }.joined(separator: " ") }.joined(separator: "\n")
    emit(Output(available: true, text: text))
  } catch {
    emit(Output(available: false, reason: "\(error)"))
  }
  exit(0)
}
guard let input = try? JSONDecoder().decode(Input.self, from: raw) else {
  emit(Output(available: false, reason: "bad input")); exit(2)
}
let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
guard case .available = model.availability else {
  emit(Output(available: false, reason: String(describing: model.availability))); exit(0)
}

let judgeInstructions = """
  You check a calendar app's work. The app read a document and found the lines below, each with a date. For each \
  one, decide whether the reader would want it on their calendar: a future appointment, meeting, class, shift, trip, \
  party, deadline or to-do that the text plans for them. Drop it if it is when a message was sent, something that \
  already happened or was cancelled, a signature, office hours, a policy, a price, marketing, a heading, or a date \
  that only describes something else. Answer one line per item: the number, then keep or drop.
  """

let sem = DispatchSemaphore(value: 0)
// a review of the rules' proposals ("1 keep", "2 drop"): yes/no is what a small model does best
if let cands = input.candidates {
  Task {
    do {
      let session = LanguageModelSession(model: model, instructions: judgeInstructions)
      let list = cands.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
      let prompt = "Today is \(input.today).\n\nThe document:\n\"\"\"\n\(String(input.text.prefix(5000)))\n\"\"\"\n\nWhat the app found:\n\(list)"
      let r = try await session.respond(to: prompt, options: GenerationOptions(sampling: .greedy, maximumResponseTokens: 400))
      var keep = Array(repeating: true, count: cands.count)
      for line in r.content.split(separator: "\n") {
        let t = line.lowercased()
        guard let n = Int(t.prefix(while: { $0.isNumber })), n >= 1, n <= cands.count else { continue }
        if t.contains("drop") { keep[n - 1] = false }
      }
      emit(Output(available: true, keep: keep))
    } catch {
      emit(Output(available: false, reason: "\(error)"))
    }
    sem.signal()
  }
  sem.wait()
  exit(0)
}
Task {
  var items: [OutItem] = []
  do {
    for part in chunks(input.text) {
      // (a fresh session per piece: nothing carries over but the instructions)
      let session = LanguageModelSession(model: model, instructions: instructions)
      let prompt = "Today is \(input.today).\n\nThe text:\n\"\"\"\n\(part)\n\"\"\""
      let r = try await session.respond(to: prompt, options: GenerationOptions(sampling: .greedy, maximumResponseTokens: 700))
      // (a line said twice is a loop, not two things)
      for it in r.content.split(separator: "\n").compactMap({ parseLine(String($0)) }) where !items.contains(where: { $0.kind == it.kind && $0.title == it.title && $0.when == it.when }) { items.append(it) }
    }
    emit(Output(available: true, items: items))
  } catch let e as LanguageModelSession.GenerationError {
    // (a piece too long or a loop that ran out of room: keep what was read)
    if case .exceededContextWindowSize = e, !items.isEmpty { emit(Output(available: true, items: items)) } else { emit(Output(available: false, reason: "\(e)")) }
  } catch {
    emit(Output(available: false, reason: "\(error)"))
  }
  sem.signal()
}
sem.wait()
