import SwiftUI

struct WorkspaceDirectoriesView: View {
    @ObservedObject var model: WorkspaceDirectoryModel
    private let paper = Color(red:246/255,green:246/255,blue:242/255)
    private let ink = Color(red:27/255,green:28/255,blue:26/255)
    private let muted = Color(red:111/255,green:115/255,blue:108/255)
    private let line = Color(red:228/255,green:229/255,blue:222/255)

    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            VStack(alignment:.leading,spacing:7) {
                Image(systemName:"folder.badge.plus").font(.system(size:25,weight:.regular))
                Text("Working directories").font(.system(size:20,weight:.semibold)).tracking(-0.5)
                Text("Choose which project folders Codas can open on this Mac.")
                    .font(.system(size:11)).foregroundColor(.white.opacity(0.72)).fixedSize(horizontal:false,vertical:true)
            }.foregroundColor(paper).frame(maxWidth:.infinity,alignment:.leading)
                .padding(15).background(ink,in:RoundedRectangle(cornerRadius:14))
            HStack {
                Text("CONFIGURED ROOTS").font(.system(size:10,weight:.semibold)).tracking(0.8)
                Spacer()
                Text(model.loaded ? String(format:"%02d",model.roots.count) : "—").font(.system(size:10,weight:.medium)).monospacedDigit()
                Button { Task { await model.refresh() } } label: {
                    Image(systemName:"arrow.clockwise").font(.system(size:11,weight:.medium))
                }.buttonStyle(.plain).disabled(model.busy).help("Refresh configuration")
            }.foregroundColor(muted)
            if !model.roots.isEmpty {
                VStack(spacing:0) {
                    ForEach(Array(model.roots.enumerated()),id:\.offset) { index, root in
                        HStack(spacing:10) {
                            Image(systemName:"folder").font(.system(size:17)).frame(width:30,height:30)
                                .background(paper,in:RoundedRectangle(cornerRadius:7))
                            VStack(alignment:.leading,spacing:4) {
                                Text(URL(fileURLWithPath:root).lastPathComponent).font(.system(size:12,weight:.semibold)).lineLimit(1)
                                Text(root).font(.system(size:10)).foregroundColor(muted).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                            }
                            Spacer(minLength:2)
                            if root == model.verifiedPath {
                                Image(systemName:"checkmark.circle.fill").foregroundColor(.green).help("New workspace admission verified")
                            }
                        }.padding(10)
                        if index < model.roots.count-1 { Divider().overlay(line).padding(.horizontal,10) }
                    }
                }.background(.white,in:RoundedRectangle(cornerRadius:12))
                    .overlay(RoundedRectangle(cornerRadius:12).strokeBorder(line,lineWidth:1))
            } else if model.busy {
                ProgressView().controlSize(.small).frame(maxWidth:.infinity).padding(12)
            } else {
                Text("Configuration unavailable").font(.system(size:12)).foregroundColor(muted).padding(10)
            }
            Button { Task { await model.chooseDirectory() } } label: {
                HStack(spacing:8) {
                    if model.busy { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName:"plus").font(.system(size:13,weight:.semibold)) }
                    Text("Add Directory").font(.system(size:12,weight:.semibold))
                }.frame(maxWidth:.infinity).padding(.vertical,12)
                    .foregroundColor(paper).background(model.canAdd ? ink : muted.opacity(0.5),in:RoundedRectangle(cornerRadius:10))
            }.buttonStyle(.plain).disabled(!model.canAdd).accessibilityIdentifier("add-working-directory")
            if !model.message.isEmpty {
                HStack(alignment:.top,spacing:7) {
                    Image(systemName:model.failed ? "exclamationmark.circle" : model.verifiedPath != nil ? "checkmark.circle" : "info.circle")
                    Text(model.message).fixedSize(horizontal:false,vertical:true)
                }.font(.system(size:11)).foregroundColor(model.failed ? .orange : muted)
            }
            HStack(alignment:.top,spacing:8) {
                Image(systemName:"lock.shield").font(.system(size:14))
                Text("Changes require local owner approval and a DevSpace restart. This controls opening workspaces, not shell isolation. Secure removal is not available yet.")
                    .font(.system(size:10)).fixedSize(horizontal:false,vertical:true)
            }.foregroundColor(muted)
        }.padding(16).foregroundColor(ink)
            .task { if !model.loaded && !model.busy { await model.refresh() } }
    }
}
