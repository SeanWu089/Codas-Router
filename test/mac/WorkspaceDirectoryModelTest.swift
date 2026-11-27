import Foundation
import AppKit

@main
struct WorkspaceDirectoryModelTest {
    @MainActor static func main() async {
        let old = "/fixture/Old", added = "/fixture/New"
        let review = WorkspaceRootReview(version:1,before:[old],after:[old,added],operation:.init(type:"add",path:added),selection:.init(path:added,dev:"1",ino:"2"),restartRequired:true,verificationRequired:true,digest:"fixture-digest")
        var calls: [String] = []
        var current = [old]
        var managed = true
        var pending = false
        var mode = "committed"
        let model = WorkspaceDirectoryModel { request in
            calls.append(request.command)
            switch request.command {
            case "list": return .init(ok:true,roots:current,managed:managed,recoveryPending:pending)
            case "review": return .init(ok:true,review:review)
            case "apply":
                precondition(request.review == review)
                if mode == "committed" { current = review.after }
                if mode == "recovery" { pending = true; return .init(ok:false,code:"RECOVERY_REQUIRED",message:"Local recovery required") }
                return .init(ok:true,roots:current,status:mode,probeRevoked:true)
            default: fatalError("Unknown test request")
            }
        }
        await model.refresh()
        precondition(model.loaded && model.canAdd && model.roots == [old])
        await model.reviewAndApply(path:added) { _ in false }
        precondition(calls == ["list","review"] && model.roots == [old], "Cancelled review must not apply")
        await model.reviewAndApply(path:added) { value in value.selection.path == added }
        precondition(model.roots == [old,added] && model.verifiedPath == added && !model.failed)
        precondition(calls.suffix(3) == ["review","apply","list"])
        mode = "rolled_back"; current = [old]
        await model.refresh()
        await model.reviewAndApply(path:added) { _ in true }
        precondition(model.failed && model.roots == [old] && model.verifiedPath == nil && model.canAdd)
        mode = "recovery"
        await model.reviewAndApply(path:added) { _ in true }
        precondition(model.failed && model.recoveryPending && !model.canAdd)
        let count = calls.count
        await model.reviewAndApply(path:added) { _ in true }
        precondition(calls.count == count, "Pending recovery must block new edits")
        pending = false; managed = false
        await model.refresh()
        precondition(!model.canAdd && model.failed)
        print("PASS: configured-root list, native review cancellation, verified activation, rollback, recovery and unmanaged service states")
    }
}
