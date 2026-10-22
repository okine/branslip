package com.okine.shizhijian

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var lastBackAt = 0L

  /* 给页面用的小桥：只有两件事，权限跳转和系统版本。
     走 addJavascriptInterface 而不是插件，是因为这两件事没有复用价值。 */
  inner class Bridge {
    @JavascriptInterface
    fun sdkInt(): Int = Build.VERSION.SDK_INT

    @JavascriptInterface
    fun requestAllFilesAccess() {
      runOnUiThread {
        try {
          startActivity(
            Intent(
              Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
              Uri.parse("package:$packageName")
            )
          )
        } catch (e: Exception) {
          try {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          } catch (_: Exception) {
            Toast.makeText(this@MainActivity, "请到系统设置里手动授予「所有文件访问」", Toast.LENGTH_LONG).show()
          }
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /* 系统栏（含输入法）高度 → android.R.id.content 的内边距。
       挂在 WebView 上不行：wry 的 WebView 不在 insets 分发链路上，
       监听器不会被调用；content 是 decorView 的直接子节点，一定会收到。 */
    val content: View? = findViewById(android.R.id.content)
    if (content != null) {
      ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
        )
        v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        WindowInsetsCompat.CONSUMED
      }
      ViewCompat.requestApplyInsets(content)
    }

    ViewCompat.getWindowInsetsController(window.decorView)?.let {
      it.isAppearanceLightStatusBars = true
      it.isAppearanceLightNavigationBars = true
    }

    /* 硬件返回键 = Esc；没有可关的层时「再按一次退出」。 */
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView
        if (wv == null) { finish(); return }
        wv.evaluateJavascript("window.__shBack ? window.__shBack() : 'none'") { res ->
          val r = res?.trim()?.trim('"') ?: "none"
          if (r == "handled") return@evaluateJavascript
          val now = System.currentTimeMillis()
          if (now - lastBackAt <= 2000L) { finish(); return@evaluateJavascript }
          lastBackAt = now
          val msg = if (r == "draft") "有草稿未保存，再按一次返回退出" else "再按一次返回退出"
          Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "ShizhijianAndroid")
  }
}