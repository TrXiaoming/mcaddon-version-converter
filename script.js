document.addEventListener('DOMContentLoaded', () => {
    
function logDebug(msg) {
    const logEl = document.getElementById('debug-log');
    if (logEl) {
        logEl.textContent += msg + '\n';
    }
    console.log(msg);
}

const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const convertBtn = document.getElementById('convert-btn');
    const targetVersionInput = document.getElementById('target-version');
    const statusMessage = document.getElementById('status-message');
    const dropZoneText = document.querySelector('.drop-zone-text');

    let selectedFile = null;

    // Drag and drop events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });

    fileInput.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.name.endsWith('.mcaddon') || file.name.endsWith('.zip') || file.name.endsWith('.mcpack')) {
                selectedFile = file;
                dropZoneText.textContent = `已選擇：${file.name}`;
                convertBtn.disabled = false;
                setStatus('');
            } else {
                selectedFile = null;
                dropZoneText.textContent = '不支援的檔案格式，請上傳 .mcaddon';
                convertBtn.disabled = true;
                setStatus('請選擇正確的 .mcaddon 檔案', 'error');
            }
        }
    }

    function setStatus(msg, type = '') {
        statusMessage.textContent = msg;
        statusMessage.className = 'status-message ' + type;
    }

    convertBtn.addEventListener('click', async () => {
        if (!selectedFile) return;

        const versionStr = targetVersionInput.value.trim();
        const versionMatch = versionStr.match(/^(\d+)\.(\d+)\.(\d+)$/);
        
        if (!versionMatch) {
            setStatus('版本格式錯誤！應為如 1.19.52', 'error');
            return;
        }

        const targetVersionArray = [
            parseInt(versionMatch[1], 10),
            parseInt(versionMatch[2], 10),
            parseInt(versionMatch[3], 10)
        ];

        try {
            convertBtn.disabled = true;
            setStatus('處理中...請稍候', 'loading');

            const buffer = await selectedFile.arrayBuffer();
            const zip = new JSZip();
            const loadedZip = await zip.loadAsync(buffer);

            let manifestFound = false;

            // Recursive function to process zip and nested zips
            async function processZip(currentZip) {
                let foundClientEntity = false;
                let foundGeometries = new Set();

                const promises = [];
                currentZip.forEach((relativePath, zipEntry) => {
                    if (!zipEntry.dir) {
                        if (relativePath.endsWith('manifest.json')) {
                            manifestFound = true;
                            const p = zipEntry.async("string").then(content => {
                                const updatedContent = updateManifest(content, targetVersionArray);
                                currentZip.file(relativePath, updatedContent);
                            });
                            promises.push(p);
                        } else if (relativePath.endsWith('.mcpack') || relativePath.endsWith('.zip')) {
                            const p = zipEntry.async("arraybuffer").then(async nestedBuffer => {
                                const nestedZip = new JSZip();
                                const loadedNestedZip = await nestedZip.loadAsync(nestedBuffer);
                                await processZip(loadedNestedZip); // Recursive call
                                const newNestedBuffer = await loadedNestedZip.generateAsync({type: "arraybuffer"});
                                currentZip.file(relativePath, newNestedBuffer);
                            });
                            promises.push(p);
                        } else if (relativePath.endsWith('.json')) {
                            const p = zipEntry.async("string").then(content => {
                                // 預先解析檢查是否存在 client_entity 與 geometry
                                try {
                                    const d = JSON.parse(content);
                                    if (d["minecraft:client_entity"]) foundClientEntity = true;
                                    if (d["minecraft:geometry"]) {
                                        d["minecraft:geometry"].forEach(g => {
                                            if (g.description && g.description.identifier) {
                                                foundGeometries.add(g.description.identifier);
                                            }
                                        });
                                    }
                                } catch(e) {}

                                const updatedContent = fixTynkerEntityFormat(content, versionStr);
                                currentZip.file(relativePath, updatedContent);
                            });
                            promises.push(p);
                        }
                    }
                });
                await Promise.all(promises);

                // [終極殺手鐧] 如果 Tynker 偷懶沒輸出 client_entity，原版遊戲會拒絕載入任何自訂模型。
                // 我們必須強行幫它捏造一個完美的 client_entity！
                if (foundGeometries.size > 0 && !foundClientEntity) {
                    for (const geoId of foundGeometries) {
                        if (geoId.endsWith(".v1.8")) continue; // 跳過我們自己產生的分身
                        
                        const name = geoId.replace("geometry.", "");
                        let texturePath = `textures/entity/${name}/${name}`; // 預設路徑
                        
                        // 動態掃描 ZIP 內符合名稱的 PNG 圖片，精準對應貼圖！
                        currentZip.forEach((relPath, entry) => {
                            if (relPath.endsWith('.png') && relPath.toLowerCase().includes(name.toLowerCase())) {
                                texturePath = relPath.replace('.png', '');
                                
                                // [Debug 功能] 將貼圖抽出來顯示在網頁上，讓使用者親眼確認 Tynker 是否裁切了貼圖！
                                promises.push(entry.async("base64").then(base64Data => {
                                    const imgDataUrl = "data:image/png;base64," + base64Data;
                                    const img = new Image();
                                    img.src = imgDataUrl;
                                    img.style.maxWidth = "100%";
                                    img.style.border = "2px solid red";
                                    img.style.marginTop = "10px";
                                    img.style.imageRendering = "pixelated"; // 保持像素風格
                                    
                                    const logContainer = document.getElementById("debug-log");
                                    if (logContainer) {
                                        const msg = document.createElement("div");
                                        msg.style.color = "yellow";
                                        msg.innerHTML = `<br><strong>⚠️ [貼圖原始檔檢視] 這是 Tynker 真正匯出的圖片：</strong><br>如果您發現這張圖沒有苦力怕的臉，或者高度只有 32 像素（下半部被切掉），代表 Tynker 在匯出時物理性地把您畫的臉刪除了，這是 Tynker 的匯出 Bug，無法透過轉換器救回。`;
                                        logContainer.appendChild(msg);
                                        logContainer.appendChild(img);
                                    }
                                }));
                            }
                        });

                        const clientEntity = {
                            "format_version": "1.10.0",
                            "minecraft:client_entity": {
                                "description": {
                                    "identifier": `minecraft:${name}`,
                                    "materials": {
                                        "default": "entity_alphatest"
                                    },
                                    "textures": {
                                        "default": texturePath
                                    },
                                    "geometry": {
                                        "default": geoId
                                    },
                                    "render_controllers": [
                                        `controller.render.${name}`
                                    ]
                                }
                            }
                        };
                        currentZip.file(`entity/${name}_tynker_fix.json`, JSON.stringify(clientEntity, null, 2));
                        if (typeof logDebug === "function") {
                            logDebug(`-> 注入缺失的 client_entity: entity/${name}_tynker_fix.json`);
                        }
                    }
                }
            }

            await processZip(loadedZip);

            if (!manifestFound) {
                setStatus('在檔案中找不到任何 manifest.json！', 'error');
                convertBtn.disabled = false;
                return;
            }

            setStatus('打包中...', 'loading');
            const blob = await loadedZip.generateAsync({
                type: "blob",
                compression: "DEFLATE",
                compressionOptions: { level: 6 }
            });

            // Trigger download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Output file name based on input
            let newName = selectedFile.name;
            if (newName.endsWith('.mcaddon')) {
                newName = newName.replace('.mcaddon', `_v${versionStr}.mcaddon`);
            } else if (newName.endsWith('.zip')) {
                newName = newName.replace('.zip', `_v${versionStr}.mcaddon`);
            } else if (newName.endsWith('.mcpack')) {
                newName = newName.replace('.mcpack', `_v${versionStr}.mcpack`);
            } else {
                newName += `_v${versionStr}.mcaddon`;
            }
            
            a.download = newName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            setStatus('轉換並下載成功！', 'success');
        } catch (error) {
            console.error(error);
            setStatus(`發生錯誤：${error.message}`, 'error');
        } finally {
            convertBtn.disabled = false;
        }
    });

    function updateManifest(manifestStr, targetVersionArray) {
        try {
            let manifest = JSON.parse(manifestStr);
            let modified = false;

            let isResourcePack = false;
            if (manifest.modules && Array.isArray(manifest.modules)) {
                isResourcePack = manifest.modules.some(mod => mod.type === "resources");
            }

            if (manifest.header) {
                if (isResourcePack) {
                    manifest.header.min_engine_version = [1, 16, 0];
                } else {
                    manifest.header.min_engine_version = targetVersionArray;
                }
                modified = true;
            }
            
            // 強制提升版本號，避免 Minecraft 讀取到舊的快取導致更新無效
            const patchVersion = Math.floor(Date.now() / 1000) % 10000;
            if (manifest.header && Array.isArray(manifest.header.version)) {
                manifest.header.version[2] = patchVersion;
                modified = true;
            }
            if (manifest.modules && Array.isArray(manifest.modules)) {
                manifest.modules.forEach(mod => {
                    if (Array.isArray(mod.version)) {
                        mod.version[2] = patchVersion;
                    }
                });
                modified = true;
            }
            
            if (manifest.format_version !== 2) {
                manifest.format_version = 2;
                modified = true;
            }
            
            return modified ? JSON.stringify(manifest, null, 2) : manifestStr;
        } catch (e) {
            console.error("解析 manifest.json 失敗", e);
            return manifestStr;
        }
    }

    function fixTynkerEntityFormat(jsonStr, versionStr) {
        try {
            let d = JSON.parse(jsonStr);
            if (d["format_version"]) logDebug("  -> format_version: " + d["format_version"]);
            if (d["minecraft:client_entity"] && d["minecraft:client_entity"].description) logDebug("  -> client_entity ID: " + d["minecraft:client_entity"].description.identifier);
            if (d["minecraft:geometry"]) logDebug("  -> 現代 geometry ID: " + d["minecraft:geometry"].map(g => g.description && g.description.identifier).join(", "));
            const legacyKeys = Object.keys(d).filter(k => k.startsWith("geometry."));
            if (legacyKeys.length > 0) logDebug("  -> 舊版 geometry: " + legacyKeys.join(", "));
        } catch(e) {}

        try {
            let data = JSON.parse(jsonStr);
            let modified = false;

            // 1. Behavior Pack Entity Fixes
            if (data["minecraft:entity"]) {
                if (data["minecraft:entity"]["format_version"]) {
                    data["format_version"] = versionStr;
                    delete data["minecraft:entity"]["format_version"];
                    modified = true;
                }

                if (data["format_version"]) {
                    const fv = data["format_version"];
                    const parts = fv.split('.').map(Number);
                    if (parts.length >= 2 && (parts[0] < 1 || (parts[0] === 1 && parts[1] < 16))) {
                        data["format_version"] = versionStr;
                        modified = true;
                    }
                }
            }

            // 2. Client Entity Fixes
            if (data["minecraft:client_entity"]) {
                if (!data["format_version"] || data["format_version"] === "1.8.0") {
                    data["format_version"] = "1.10.0"; 
                    modified = true;
                }
            }

            // 3. Migrate legacy geometries to modern 1.12.0 format
            const legacyGeometryKeys = Object.keys(data).filter(key => key.startsWith("geometry."));
            if (legacyGeometryKeys.length > 0) {
                const newGeometries = [];
                for (const geoKey of legacyGeometryKeys) {
                    const oldGeo = data[geoKey];
                    const description = { identifier: geoKey };
                    
                    description.texture_width = oldGeo.texturewidth || oldGeo.texture_width || 64;
                    description.texture_height = oldGeo.textureheight || oldGeo.texture_height || 64;
                    
                    if (oldGeo.visible_bounds_width !== undefined) description.visible_bounds_width = oldGeo.visible_bounds_width;
                    if (oldGeo.visible_bounds_height !== undefined) description.visible_bounds_height = oldGeo.visible_bounds_height;
                    if (oldGeo.visible_bounds_offset !== undefined) description.visible_bounds_offset = oldGeo.visible_bounds_offset;

                    const newGeo = {
                        description: description,
                        bones: oldGeo.bones || []
                    };
                    newGeometries.push(newGeo);
                    
                    // [大絕招] 如果原版的 client_entity 發生退回，它會要求尋找 "geometry.xxx.v1.8"。
                    // 我們自動複製一份帶有 .v1.8 後綴的模型，確保無論如何都能成功攔截並顯示！
                    if (!geoKey.endsWith(".v1.8")) {
                        const duplicateGeo = JSON.parse(JSON.stringify(newGeo));
                        duplicateGeo.description.identifier = geoKey + ".v1.8";
                        newGeometries.push(duplicateGeo);
                    }
                    
                    delete data[geoKey]; 
                }
                
                data["minecraft:geometry"] = newGeometries;
                data["format_version"] = "1.12.0";
                modified = true;
            }

            // 4. Sanitize all geometries
            if (Array.isArray(data["minecraft:geometry"])) {
                if (!data["format_version"]) {
                    data["format_version"] = "1.12.0";
                    modified = true;
                }
                
                const extraGeos = [];

                data["minecraft:geometry"].forEach(geo => {
                    if (geo.description) {
                        // 強制 Tynker 的貼圖尺寸至少為 64x64，避免原版的 64x32 導致下方貼圖被截斷拉伸
                        if (geo.description.texture_width === undefined || geo.description.texture_width < 64) {
                            geo.description.texture_width = 64;
                            modified = true;
                        }
                        if (geo.description.texture_height === undefined || geo.description.texture_height < 64) {
                            geo.description.texture_height = 64;
                            modified = true;
                        }
                    }

                    if (Array.isArray(geo.bones)) {
                        // 確保骨架名稱不重複
                        const seenBones = new Set();
                        geo.bones.forEach((bone, index) => {
                            if (!bone.name) {
                                bone.name = "bone_" + index;
                                modified = true;
                            }
                            let originalName = bone.name;
                            let counter = 1;
                            while (seenBones.has(bone.name)) {
                                bone.name = originalName + "_" + counter;
                                counter++;
                                modified = true;
                            }
                            seenBones.add(bone.name);
                        });
                        
                        // 移除無效的 parent
                        const allBoneNames = new Set(geo.bones.map(b => b.name));
                        geo.bones.forEach(bone => {
                            if (bone.parent && !allBoneNames.has(bone.parent)) {
                                delete bone.parent;
                                modified = true;
                            }
                            
                            if (Array.isArray(bone.cubes)) {
                                bone.cubes.forEach(cube => {
                                    if (cube.uv === undefined) {
                                        cube.uv = [0, 0];
                                        modified = true;
                                    }

                                    // 檢查是否為被 Tynker 裁切掉的失效 UV 區域 (y >= 32)
                                    let isOutOfBounds = false;
                                    if (Array.isArray(cube.uv) && cube.uv[1] >= 32) {
                                        isOutOfBounds = true;
                                    } else if (typeof cube.uv === 'object' && !Array.isArray(cube.uv)) {
                                        for (const face in cube.uv) {
                                            if (cube.uv[face].uv && cube.uv[face].uv[1] >= 32) {
                                                isOutOfBounds = true;
                                                break;
                                            }
                                        }
                                    }

                                    if (isOutOfBounds) {
                                        // [終極 Per-Face UV 復原大法]
                                        // Tynker 搞丟了這些方塊的貼圖，且負數尺寸會導致傳統 [0,0] Box UV 的正反面顛倒。
                                        // 我們直接寫死六個面的獨立 UV 座標，強行鎖定正面就是苦力怕的臉！
                                        cube.uv = {
                                            "up": { "uv": [8, 0], "uv_size": [8, 8] },
                                            "down": { "uv": [16, 0], "uv_size": [8, 8] },
                                            "east": { "uv": [0, 8], "uv_size": [8, 8] },    // 右側
                                            "north": { "uv": [8, 8], "uv_size": [8, 8] },   // 正面 (臉)
                                            "west": { "uv": [16, 8], "uv_size": [8, 8] },   // 左側
                                            "south": { "uv": [24, 8], "uv_size": [8, 8] }   // 背面
                                        };
                                        modified = true;
                                    } else if (Array.isArray(cube.uv)) {
                                        if (cube.uv[0] < 0) { cube.uv[0] = 0; modified = true; }
                                        if (cube.uv[1] < 0) { cube.uv[1] = 0; modified = true; }
                                    }
                                    
                                    if (Array.isArray(cube.size)) {
                                        for (let i = 0; i < 3; i++) {
                                            if (cube.size[i] < 0) {
                                                if (Array.isArray(cube.origin)) {
                                                    cube.origin[i] += cube.size[i];
                                                }
                                                cube.size[i] = Math.abs(cube.size[i]);
                                                modified = true;
                                            }
                                        }
                                    }
                                });
                            }
                        });
                    }
                    
                    // [大絕招 - 適用於現代模型]
                    // Tynker 沒有輸出 client_entity，所以系統會退回使用原版設定。
                    // 而原版 1.21 系統要求模型名稱必須以 .v1.8 結尾。
                    // 因此我們自動幫這個現代模型建立一個 .v1.8 的分身！
                    if (geo.description && geo.description.identifier && !geo.description.identifier.endsWith(".v1.8")) {
                        const duplicateGeo = JSON.parse(JSON.stringify(geo));
                        duplicateGeo.description.identifier = geo.description.identifier + ".v1.8";
                        extraGeos.push(duplicateGeo);
                        modified = true;
                    }
                });
                
                if (extraGeos.length > 0) {
                    data["minecraft:geometry"].push(...extraGeos);
                }
            }

            return modified ? JSON.stringify(data, null, 2) : jsonStr;
        } catch (e) {
            // Ignore non-JSON or malformed files
            return jsonStr;
        }
    }
});
