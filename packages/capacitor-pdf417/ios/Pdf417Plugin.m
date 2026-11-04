#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor and exposes its methods to JS.
CAP_PLUGIN(Pdf417Plugin, "Pdf417",
    CAP_PLUGIN_METHOD(decodePdf417, CAPPluginReturnPromise);
)
