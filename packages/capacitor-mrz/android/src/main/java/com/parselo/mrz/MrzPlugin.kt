package com.parselo.mrz

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

@CapacitorPlugin(name = "Mrz")
class MrzPlugin : Plugin() {

    @PluginMethod
    fun recognizeText(call: PluginCall) {
        val imageStr = call.getString("image") ?: run {
            call.reject("Missing 'image'"); return
        }
        val bitmap = loadBitmap(imageStr) ?: run {
            call.reject("Could not load image from the provided string"); return
        }
        recognize(bitmap) { lines ->
            val arr = JSArray()
            lines.forEach { arr.put(it) }
            val ret = JSObject()
            ret.put("lines", arr)
            ret.put("raw", lines.joinToString("\n"))
            call.resolve(ret)
        }
    }

    // ML Kit Text Recognition v2, Latin script, fully on-device.
    private fun recognize(bitmap: Bitmap, callback: (List<String>) -> Unit) {
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val image = InputImage.fromBitmap(bitmap, 0)
        recognizer.process(image)
            .addOnSuccessListener { result ->
                // Flatten to one entry per line so scanner-core can scan
                // the array for consecutive 44-char TD3 lines.
                val lines = result.textBlocks.flatMap { block ->
                    block.lines.map { line -> line.text }
                }
                callback(lines)
            }
            .addOnFailureListener { callback(emptyList()) }
    }

    // Image loading: file path, file:// URI, data: URI, or bare base64.
    private fun loadBitmap(s: String): Bitmap? {
        return try {
            when {
                s.startsWith("data:") -> {
                    val b64   = s.substringAfter(",", "")
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
                s.startsWith("file://") -> BitmapFactory.decodeFile(Uri.parse(s).path)
                s.startsWith("/")       -> BitmapFactory.decodeFile(s)
                else -> {
                    val bytes = Base64.decode(s, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            }
        } catch (e: Exception) { null }
    }
}
