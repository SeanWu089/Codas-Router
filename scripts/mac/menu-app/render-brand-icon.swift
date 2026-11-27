import AppKit
import Foundation

// Render the exact shared brand SVG (simple rect and circle vocabulary) to
// all native iconset sizes. Fail rather than silently approximate new art.
let args = CommandLine.arguments
guard args.count == 3 else { fatalError("Usage: render-brand-icon <svg> <iconset>") }
let document = try XMLDocument(contentsOf: URL(fileURLWithPath: args[1]), options: [])
guard let root = document.rootElement(), root.localName == "svg",
      root.attribute(forName:"viewBox")?.stringValue == "0 0 120 120" else { fatalError("Unexpected brand SVG geometry") }
func value(_ element: XMLElement, _ key: String) -> CGFloat {
    guard let raw = element.attribute(forName:key)?.stringValue, let result = Double(raw) else { fatalError("Missing SVG coordinate") }
    return CGFloat(result)
}
func color(_ text: String) -> NSColor {
    guard text.count == 7, text.hasPrefix("#"), let rgb = UInt32(text.dropFirst(),radix:16) else { fatalError("Unexpected SVG color") }
    return NSColor(srgbRed:CGFloat((rgb >> 16) & 255)/255,green:CGFloat((rgb >> 8) & 255)/255,blue:CGFloat(rgb & 255)/255,alpha:1)
}
func draw(_ element: XMLElement, inherited: String? = nil) {
    let fill = element.attribute(forName:"fill")?.stringValue ?? inherited
    switch element.localName {
    case "svg", "g":
        for child in element.children ?? [] { if let node = child as? XMLElement { draw(node,inherited:fill) } }
    case "title": break
    case "rect":
        guard let fill else { fatalError("Missing rect fill") }
        color(fill).setFill()
        let rx = value(element,"rx")
        NSBezierPath(roundedRect:NSRect(x:value(element,"x"),y:value(element,"y"),width:value(element,"width"),height:value(element,"height")),xRadius:rx,yRadius:rx).fill()
    case "circle":
        guard let fill else { fatalError("Missing circle fill") }
        color(fill).setFill()
        let r = value(element,"r")
        NSBezierPath(ovalIn:NSRect(x:value(element,"cx")-r,y:value(element,"cy")-r,width:2*r,height:2*r)).fill()
    default: fatalError("Unsupported brand SVG element")
    }
}
let directory = URL(fileURLWithPath:args[2],isDirectory:true)
try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let pixels = size*scale
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0),
              let context = NSGraphicsContext(bitmapImageRep:bitmap) else { fatalError("Bitmap allocation failed") }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(x:0,y:0,width:pixels,height:pixels))
        context.cgContext.translateBy(x:0,y:CGFloat(pixels))
        context.cgContext.scaleBy(x:CGFloat(pixels)/120,y:-CGFloat(pixels)/120)
        draw(root)
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let data = bitmap.representation(using:.png,properties:[:]) else { fatalError("Icon PNG encoding failed") }
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try data.write(to:directory.appendingPathComponent(name))
    }
}
