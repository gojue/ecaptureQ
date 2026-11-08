// Build-time only: preserve the official SVG, including its transparent canvas.
#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "Usage: render-icon source.svg output.iconset\n");
      return 1;
    }
    NSImage *image = [[NSImage alloc] initWithContentsOfFile:@(argv[1])];
    if (!image || ![image isValid]) {
      fprintf(stderr, "Cannot decode the official icon SVG\n");
      return 1;
    }
    // Apple's iconset sizes: 16, 32, 128, 256, 512 points at 1x and 2x.
    for (NSNumber *points in @[@16, @32, @128, @256, @512]) {
      for (NSInteger scale = 1; scale <= 2; scale++) {
        NSInteger pixels = points.integerValue * scale;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL pixelsWide:pixels pixelsHigh:pixels
            bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
            colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        if (!bitmap || !context) {
          fprintf(stderr, "Cannot allocate icon bitmap\n");
          return 1;
        }
        NSRect bounds = NSMakeRect(0, 0, pixels, pixels);
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:context];
        [[NSColor clearColor] setFill];
        NSRectFillUsingOperation(bounds, NSCompositingOperationCopy);
        [context setImageInterpolation:NSImageInterpolationHigh];
        [image drawInRect:bounds fromRect:NSZeroRect
            operation:NSCompositingOperationSourceOver fraction:1.0];
        [NSGraphicsContext restoreGraphicsState];
        NSString *name = [NSString stringWithFormat:@"icon_%@x%@%@.png",
            points, points, scale == 2 ? @"@2x" : @""];
        NSString *path = [@(argv[2]) stringByAppendingPathComponent:name];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png || ![png writeToFile:path atomically:YES]) {
          fprintf(stderr, "Cannot write icon PNG\n");
          return 1;
        }
      }
    }
    return 0;
  }
}
