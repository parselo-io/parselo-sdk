#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor and exposes its methods to JS.
CAP_PLUGIN(MrzPlugin, "Mrz",
    CAP_PLUGIN_METHOD(recognizeText, CAPPluginReturnPromise);
)
