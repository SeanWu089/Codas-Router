package com.codassol.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.view.*
import android.net.Uri
import android.text.InputType
import android.widget.*

class MainActivity : Activity() {
    private lateinit var store: PhoneStore
    private lateinit var endpoint: EditText
    private lateinit var pairing: EditText
    private lateinit var access: Switch
    private lateinit var status: TextView
    private lateinit var install: Button
    private val main=Handler(Looper.getMainLooper())
    private var rendering=false
    private val refresh=object:Runnable { override fun run() { render();main.postDelayed(this,1000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState);store=PhoneStore(this)

        val bg = Color.rgb(246,246,242)
        root = FrameLayout(this).apply { setBackgroundColor(bg) }
        window.setDecorFitsSystemWindows(false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left,bars.top,bars.right,maxOf(bars.bottom,ime.bottom))
            insets
        }
        val column = vertical().apply { setPadding(dp(20),dp(18),dp(20),dp(32)) }
        root.addView(ScrollView(this).apply { isFillViewport=true; isVerticalScrollBarEnabled=false; addView(column) },
            FrameLayout.LayoutParams(-1,-1))
        val header = horizontal().apply { setPadding(dp(4),0,dp(4),0) }
        val word = txt("codas.",27f,INK,true).apply {
            text = android.text.SpannableString("codas.").also { it.setSpan(android.text.style.ForegroundColorSpan(RED),5,6,0) }
            letterSpacing = -.06f
        }
        header.addView(word,LinearLayout.LayoutParams(0,-2,1f))
        header.addView(ImageButton(this).apply {
            contentDescription="设置"; setImageResource(R.drawable.ic_codas_settings); background=shape(SOFT,100)
            scaleType=ImageView.ScaleType.CENTER_INSIDE; setPadding(dp(11),dp(11),dp(11),dp(11))
            setOnClickListener { openPanel(settingsPanel) }
        },LinearLayout.LayoutParams(dp(44),dp(44)))
        column.addView(header)
        val hero = vertical().apply { gravity=Gravity.CENTER_HORIZONTAL; setPadding(0,dp(36),0,dp(32)) }
        art=ConnectionArt(this)
        hero.addView(art,LinearLayout.LayoutParams(dp(230),dp(165)))
        heading=txt("未连接",36f,INK,true).apply { gravity=Gravity.CENTER; setPadding(0,dp(18),0,0) }
        hero.addView(heading)
        subtitle=txt("本机 · Codas 网络",13f,MUTED).apply { gravity=Gravity.CENTER; setPadding(dp(8),dp(8),dp(8),0) }
        hero.addView(subtitle,LinearLayout.LayoutParams(-1,-2))
        column.addView(hero)
        val accessCard=horizontal().apply { background=shape(INK,22); setPadding(dp(18),dp(20),dp(17),dp(20)); minimumHeight=dp(88) }
        val accessText=vertical()
        accessText.addView(txt("允许访问",17f,Color.WHITE,true))
        accessDesc=txt("开启后连接 AI 助手",12f,Color.rgb(190,191,184)).apply { setPadding(0,dp(7),dp(8),0) }
        accessText.addView(accessDesc)
        accessCard.addView(accessText,LinearLayout.LayoutParams(0,-2,1f))
        access=Switch(this).apply {
            contentDescription="允许 Codas 访问手机"; showText=false; minWidth=dp(56); minimumHeight=dp(48)
            thumbTintList=ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked),intArrayOf()),intArrayOf(INK,Color.WHITE))
            trackTintList=ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked),intArrayOf()),intArrayOf(Color.WHITE,Color.rgb(111,113,105)))
        }
        accessCard.addView(access,LinearLayout.LayoutParams(-2,-2)); column.addView(accessCard)
        val taskCard=horizontal().apply {
            background=shape(SOFT,22); setPadding(dp(17),dp(18),dp(17),dp(18)); minimumHeight=dp(76)
            isClickable=true; isFocusable=true; setOnClickListener { openPanel(taskPanel) }
        }
        taskCard.addView(ImageView(this).apply { setImageResource(R.drawable.ic_codas_package) },LinearLayout.LayoutParams(dp(32),dp(32)))
        val taskText=vertical().apply { setPadding(dp(13),0,dp(8),0) }
        taskText.addView(txt("测试应用",15f,INK,true))
        taskSummary=txt("暂无待安装应用",12f,MUTED).apply { setPadding(0,dp(5),0,0) }
        taskText.addView(taskSummary)
        taskCard.addView(taskText,LinearLayout.LayoutParams(0,-2,1f))
        taskCard.addView(txt("›",26f,MUTED))
        column.addView(taskCard,LinearLayout.LayoutParams(-1,-2).apply { topMargin=dp(12) })

        scrim=View(this).apply { setBackgroundColor(0x66000000); visibility=View.GONE; setOnClickListener { closePanels() } }
        root.addView(scrim,FrameLayout.LayoutParams(-1,-1))

        val settings=vertical().apply { setPadding(dp(22),dp(12),dp(22),dp(24)) }
        sheetHeader(settings,"设置")
        status=txt("",13f,MUTED).apply { setPadding(0,0,0,dp(12)); setTextIsSelectable(true) }
        settings.addView(status)
        settings.addView(section("连接配置"))
        settings.addView(txt("Codas 入口",13f,INK,true))
        endpoint=EditText(this).apply { hint="https://router.example.com";setSingleLine();inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI;setText(store.endpoint);textSize=14f }
        settings.addView(endpoint)
        settings.addView(txt("首次配对码（已有配对可留空）",13f,INK,true))
        pairing=EditText(this).apply { hint="输入配对码";setSingleLine();inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD;textSize=14f }
        settings.addView(pairing)
        settings.addView(section("权限与安全"))
        settings.addView(action("允许截图与测试操作",false) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
        settings.addView(txt("在系统无障碍设置中启用“Codas 测试控制”。截图与点击只在访问开关开启时接受；系统授权和安装确认由你操作。",12f,MUTED))
        settings.addView(action("允许安装测试应用",false) { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName"))) })
        settings.addView(action("允许后台连接（锁屏使用）",false) {
            val power = getSystemService(android.os.PowerManager::class.java)
            if (!power.isIgnoringBatteryOptimizations(packageName)) startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            else Toast.makeText(this, "已允许后台连接", Toast.LENGTH_SHORT).show()
        })
        settings.addView(txt("访问开启时保持后台连接，会增加耗电。关闭访问即可停止；系统强行停止后需重新打开应用，手机重启后需手动开启。",12f,MUTED))
        settings.addView(section("关于 Codas"))
        settings.addView(txt("版本 "+(packageManager.getPackageInfo(packageName,0).versionName ?: ""),13f,INK))
        settings.addView(txt("手机标识\n"+store.deviceId,11f,MUTED).apply { setTextIsSelectable(true) })
        settingsPanel=panel(settings)

        val tasks=vertical().apply { setPadding(dp(22),dp(12),dp(22),dp(32)) }
        sheetHeader(tasks,"测试应用")
        val packageIcon=ImageView(this).apply { setImageResource(R.drawable.ic_codas_package); background=shape(SOFT,20); setPadding(dp(16),dp(16),dp(16),dp(16)) }
        tasks.addView(packageIcon,LinearLayout.LayoutParams(dp(64),dp(64)).apply { gravity=Gravity.CENTER_HORIZONTAL; topMargin=dp(12); bottomMargin=dp(16) })
        taskHeading=txt("暂无待安装应用",19f,INK,true).apply { gravity=Gravity.CENTER }
        tasks.addView(taskHeading,LinearLayout.LayoutParams(-1,-2))
        taskDetail=txt("AI 助手发送测试安装包后，你可以在这里查看并安装。",13f,MUTED).apply { gravity=Gravity.CENTER; setPadding(0,dp(9),0,dp(17)); setTextIsSelectable(true) }
        tasks.addView(taskDetail,LinearLayout.LayoutParams(-1,-2))
        taskProgress=ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate=true; indeterminateTintList=ColorStateList.valueOf(RED); visibility=View.GONE }
        tasks.addView(taskProgress,LinearLayout.LayoutParams(-1,dp(4)).apply { bottomMargin=dp(12) })
        install=action("安装收到的测试包",true) {
            val state=ApkOperations.snapshot(this)
            if(state.optString("status")=="awaiting_confirmation") {
                val next=ApkOperations.confirmation(); if(next!=null) startActivity(next)
            } else ApkOperations.install(this)
        }
        tasks.addView(install)
        taskPanel=panel(tasks)
        setContentView(root)
        // The decor/window insets controller may not exist before attachment (Android 16).
        root.post {
            root.windowInsetsController?.setSystemBarsAppearance(
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            )
        }
        root.requestApplyInsets()
        access.setOnCheckedChangeListener { _,checked ->
            if(rendering) return@setOnCheckedChangeListener
            if(checked) {
                try {
                    check(AgentService.current==null) { "WAIT_FOR_SERVICE_STOP" }
                    if (endpoint.text.toString().isBlank()) throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED")
                    try { store.endpoint=endpoint.text.toString() } catch (_: IllegalArgumentException) { throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED") }
                    val token=pairing.text.toString().trim()
                    check(store.token()!=null || token.isNotEmpty()) { "PAIRING_REQUIRED" }
                    if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),4)
                    startForegroundService(Intent(this,AgentService::class.java).putExtra("pairing",token))
                    pairing.text.clear()
                } catch(e:Exception) { AgentState.status="无法开启：${friendlyError(safeError(e))}";render() }
            } else {
                store.requestAccess(false);AgentState.disable();AgentService.current?.disable();ApkOperations.cancel(this);render()
            }
        }
    }
    override fun onResume() {
        super.onResume()
        if (store.accessRequested() && AgentService.current == null) startForegroundService(Intent(this, AgentService::class.java))
        main.post(refresh)
    }
    override fun onPause() { main.removeCallbacks(refresh);super.onPause() }

    private lateinit var root: FrameLayout
    private lateinit var scrim: View
    private lateinit var settingsPanel: View
    private lateinit var taskPanel: View
    private lateinit var art: ConnectionArt
    private lateinit var heading: TextView
    private lateinit var subtitle: TextView
    private lateinit var accessDesc: TextView
    private lateinit var taskSummary: TextView
    private lateinit var taskHeading: TextView
    private lateinit var taskDetail: TextView
    private lateinit var taskProgress: ProgressBar

    private fun dp(value:Int)=(value*resources.displayMetrics.density+.5f).toInt()
    private fun shape(color:Int,radius:Int)=GradientDrawable().apply { setColor(color); cornerRadius=dp(radius).toFloat() }
    private fun vertical()=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL }
    private fun horizontal()=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL }
    private fun txt(value:String,size:Float,color:Int,bold:Boolean=false)=TextView(this).apply {
        text=value; textSize=size; setTextColor(color); if(bold) typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
    }
    private fun section(value:String)=txt(value,13f,MUTED,true).apply { setPadding(0,dp(19),0,dp(8)) }
    private fun action(title:String,primary:Boolean,run:()->Unit)=Button(this).apply {
        text=title; isAllCaps=false; textSize=14f; minHeight=dp(48); minimumHeight=dp(48)
        setTextColor(if(primary) Color.WHITE else INK); background=shape(if(primary) INK else SOFT,14)
        setOnClickListener { try { run() } catch(e:Exception) { Toast.makeText(this@MainActivity,safeError(e),Toast.LENGTH_LONG).show() } }
        layoutParams=LinearLayout.LayoutParams(-1,-2).apply { topMargin=dp(8); bottomMargin=dp(8) }
    }
    private fun sheetHeader(column:LinearLayout,title:String) {
        column.addView(View(this).apply { background=shape(Color.rgb(201,202,196),8) },
            LinearLayout.LayoutParams(dp(32),dp(4)).apply { gravity=Gravity.CENTER_HORIZONTAL; bottomMargin=dp(18) })
        val row=horizontal()
        row.addView(txt(title,23f,INK,true),LinearLayout.LayoutParams(0,-2,1f))
        row.addView(TextView(this).apply { text="×"; textSize=23f; gravity=Gravity.CENTER; background=shape(SOFT,100); contentDescription="关闭"; isClickable=true; isFocusable=true; setOnClickListener { closePanels() } },LinearLayout.LayoutParams(dp(40),dp(40)))
        column.addView(row,LinearLayout.LayoutParams(-1,-2).apply { bottomMargin=dp(16) })
    }
    private fun panel(column:LinearLayout):View {
        val scroll=object:ScrollView(this) {
            override fun onMeasure(w:Int,h:Int) {
                val maxHeight=(resources.displayMetrics.heightPixels*.84).toInt()
                super.onMeasure(w,View.MeasureSpec.makeMeasureSpec(minOf(View.MeasureSpec.getSize(h),maxHeight),View.MeasureSpec.AT_MOST))
            }
        }.apply { background=shape(BG,27); isFillViewport=false; isVerticalScrollBarEnabled=false; isClickable=true; addView(column); visibility=View.GONE }
        root.addView(scroll,FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM))
        return scroll
    }
    private fun openPanel(target:View) {
        settingsPanel.visibility=View.GONE; taskPanel.visibility=View.GONE
        scrim.visibility=View.VISIBLE; target.visibility=View.VISIBLE
        target.translationY=dp(22).toFloat(); target.alpha=0f
        target.animate().translationY(0f).alpha(1f).setDuration(220).start()
    }
    private fun closePanels() {
        if(scrim.visibility!=View.VISIBLE) return
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(root.windowToken,0)
        settingsPanel.visibility=View.GONE; taskPanel.visibility=View.GONE; scrim.visibility=View.GONE
    }
    @Deprecated("Android back compatibility")
    override fun onBackPressed() { if(::scrim.isInitialized && scrim.visibility==View.VISIBLE) closePanels() else super.onBackPressed() }

    private fun renderPresentation(op:org.json.JSONObject) {
        val enabled=AgentState.enabled
        val connected=enabled && AgentState.connected
        val message=AgentState.status
        val recovering=message.contains("重连") || message.contains("恢复") || message.contains("中断")
        val failed=!enabled && (message.startsWith("无法开启") || message.startsWith("连接停止"))
        heading.text=when { connected -> "已连接"; enabled && recovering -> "正在重连"; enabled -> "连接中"; else -> "未连接" }
        subtitle.text=when { failed -> message; enabled && !connected -> if(recovering) "正在恢复安全连接…" else "正在建立安全连接…"; else -> (if(Build.MANUFACTURER.equals("nubia",true)) "RedMagic" else Build.MODEL)+" · Codas 网络" }
        accessDesc.text=when { connected -> "AI 助手可操作此设备"; enabled -> "正在连接 Codas 网络"; else -> "开启后连接 AI 助手" }
        art.mode=if(connected) 2 else if(enabled) 1 else 0
        val code=op.optString("status")
        val empty=code=="idle" || code.isBlank()
        taskSummary.text=if(empty) "暂无待安装应用" else installStatus(code)
        taskHeading.text=if(empty) "暂无待安装应用" else installStatus(code)
        taskDetail.text=if(empty) "AI 助手发送测试安装包后，你可以在这里查看并安装。" else listOf(op.optString("package"),op.optString("version"),friendlyError(op.optString("error"))).filter { it.isNotBlank() }.joinToString("\n")
        taskProgress.visibility=if(code=="downloading" || code=="installing") View.VISIBLE else View.GONE
        install.visibility=if(code in listOf("ready_to_install","awaiting_confirmation")) View.VISIBLE else View.GONE
    }

    companion object {
        private val BG=Color.rgb(246,246,242)
        private val INK=Color.rgb(27,28,26)
        private val SOFT=Color.rgb(235,235,230)
        private val MUTED=Color.rgb(118,120,113)
        private val RED=Color.rgb(217,52,43)
    }

    private class ConnectionArt(context:android.content.Context):View(context) {
        private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
        var mode=0
            set(value) { if(field!=value) { field=value; invalidate() } }
        private fun rect(c:Canvas,x:Float,y:Float,w:Float,h:Float,r:Float,color:Int) {
            paint.style=Paint.Style.FILL;paint.color=color;c.drawRoundRect(x,y,x+w,y+h,r,r,paint)
        }
        private fun dots(c:Canvas,x:Float,y:Float,w:Float,h:Float,r:Float,color:Int) {
            c.save();c.clipRect(x,y,x+w,y+h);paint.style=Paint.Style.FILL;paint.color=color
            var i=x+2.5f;while(i<x+w) { var j=y+2.5f;while(j<y+h) { c.drawCircle(i,j,r,paint);j+=5f };i+=5f }
            c.restore()
        }
        override fun onDraw(canvas:Canvas) {
            super.onDraw(canvas)
            canvas.save();val scale=minOf(width/230f,height/165f);canvas.translate((width-230*scale)/2f,(height-165*scale)/2f);canvas.scale(scale,scale)
            dots(canvas,0f,0f,230f,165f,1.05f,Color.rgb(216,218,212))
            rect(canvas,21f,41f,55f,80f,10f,BG)
            dots(canvas,25f,45f,47f,72f,1.85f,INK)
            rect(canvas,32f,52f,33f,53f,3f,BG)
            dots(canvas,43f,108f,12f,4f,1.85f,INK)
            val remote=if(mode==0) Color.rgb(181,183,176) else INK
            rect(canvas,154f,46f,62f,65f,5f,BG)
            dots(canvas,155f,50f,60f,45f,1.85f,remote)
            rect(canvas,162f,57f,46f,30f,1f,BG)
            dots(canvas,179f,95f,12f,13f,1.85f,remote)
            dots(canvas,170f,105f,30f,7f,1.85f,remote)
            val animate=mode!=0 && android.animation.ValueAnimator.areAnimatorsEnabled()
            val now=android.os.SystemClock.uptimeMillis()
            for(i in 0..6) {
                val wave=if(animate) ((now/1000.0*3-i*.56)%6.28+6.28)%6.28 else 0.0
                val strength=((kotlin.math.cos(wave)+1)/2).toFloat()
                paint.style=Paint.Style.FILL
                paint.color=when { mode==0 -> Color.rgb(190,193,186); mode==1 && strength<.42f -> Color.rgb(190,193,186); else -> RED }
                paint.alpha=if(mode==2 && animate) (150+105*strength).toInt() else 255
                canvas.drawCircle(84f+i*10,80f,if(mode==2 && animate) 2.5f+strength else if(i==3) 3.1f else 2.5f,paint)
            }
            paint.alpha=255
            if(mode==2 && animate) {
                val pulse=(now%3000)/3000f
                paint.style=Paint.Style.STROKE; paint.strokeWidth=1f; paint.color=RED;paint.alpha=((1-pulse)*80).toInt()
                canvas.drawCircle(114f,80f,6f+15f*pulse,paint);paint.alpha=255;paint.style=Paint.Style.FILL
            }
            canvas.restore()
            if(animate && isShown && windowVisibility==View.VISIBLE) postInvalidateDelayed(33)
        }
    }

    private fun friendlyError(code:String) = when(code) {
        "HTTPS_ORIGIN_REQUIRED" -> "请填写有效的 HTTPS Codas 入口"
        "PAIRING_REQUIRED" -> "请填写首次配对码"
        "WAIT_FOR_SERVICE_STOP" -> "正在关闭连接，请稍后重试"
        "APK_HASH_MISMATCH" -> "安装包校验不一致，请重新发送"
        "ALLOW_INSTALLATION_ON_PHONE" -> "请先允许安装测试应用"
        else -> code
    }
    private fun installStatus(code:String) = when(code) {
        "idle" -> "尚无安装任务"
        "downloading" -> "正在下载安装包"
        "ready_to_install" -> "已下载，请点下方按钮安装"
        "installing" -> "正在准备系统安装"
        "awaiting_confirmation" -> "请点下方按钮继续系统确认"
        "installed" -> "安装完成"
        "cancelled" -> "已取消"
        "failed" -> "安装失败"
        else -> code
    }
    private fun render() {
        if(!::status.isInitialized) return
        rendering=true;access.isChecked=AgentState.enabled;rendering=false
        endpoint.isEnabled=!AgentState.enabled;pairing.isEnabled=!AgentState.enabled
        val op=ApkOperations.snapshot(this)
        val backgroundAllowed = getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        status.text="${AgentState.status}\n后台连接：${if(backgroundAllowed) "已允许" else "请点下方按钮允许锁屏连接"}\n测试控制：${if(PhoneAccessibility.current!=null) "已授权" else "未授权"}\n最近操作：${AgentState.lastAction}\n安装：${installStatus(op.optString("status"))} ${op.optString("package")}\n${friendlyError(op.optString("error"))}"
        install.isEnabled=AgentState.enabled && op.optString("status") in listOf("ready_to_install","awaiting_confirmation")
        install.text=if(op.optString("status")=="awaiting_confirmation") "继续系统安装确认" else "安装收到的测试包"
        renderPresentation(op)
    }
}
