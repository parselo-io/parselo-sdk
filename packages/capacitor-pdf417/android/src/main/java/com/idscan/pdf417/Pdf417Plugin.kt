package com.idscan.pdf417

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

@CapacitorPlugin(name = "Pdf417")
class Pdf417Plugin : Plugin() {

    @PluginMethod
    fun decodePdf417(call: PluginCall) {
        val imageStr = call.getString("image") ?: run {
            call.reject("Missing 'image'"); return
        }
        val bitmap = loadBitmap(imageStr) ?: run {
            call.reject("Could not load image from the provided string"); return
        }
        decode(bitmap) { raw ->
            val ret = JSObject()
            ret.put("raw", raw)
            ret.put("format", if (raw != null) "pdf417" else null)
            call.resolve(ret)
        }
    }

    // ML Kit decode, restricted to PDF417.
    private fun decode(bitmap: Bitmap, callback: (String?) -> Unit) {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_PDF417)
            .build()
        val scanner = BarcodeScanning.getClient(options)
        val image = InputImage.fromBitmap(bitmap, 0)
        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                val bc = barcodes.firstOrNull()
                // rawBytes decoded 1:1 (ISO-8859-1) preserves the AAMVA control
                // bytes (@, LF, RS); fall back to rawValue if rawBytes is null.
                val raw = bc?.rawBytes?.toString(Charsets.ISO_8859_1) ?: bc?.rawValue
                callback(raw)
            }
            .addOnFailureListener { callback(null) }
    }

    // Image loading: file path, file:// URI, data: URI, or bare base64.
    private fun loadBitmap(s: String): Bitmap? {
        return try {
            when {
                s.startsWith("data:") -> {
                    val b64 = s.substringAfter(",", "")
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
                s.startsWith("file://") -> BitmapFactory.decodeFile(Uri.parse(s).path)
                s.startsWith("/") -> BitmapFactory.decodeFile(s)
                else -> {
                    val bytes = Base64.decode(s, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            }
        } catch (e: Exception) {
            null
        }
    }
}
