# -*- coding: utf-8 -*-
"""Dev/test helper: re-encodes any audio file to OGG/Opus mono 48 kHz (the container Meta uses for WhatsApp voice notes) using PyAV.
Usage: python dev_to_ogg.py <src> <dst>"""
import sys
import av

src, dst = sys.argv[1], sys.argv[2]
inp = av.open(src)
out = av.open(dst, "w", format="ogg")
oa = out.add_stream("libopus", rate=48000)
oa.layout = "mono"
rs = av.AudioResampler(format="flt", layout="mono", rate=48000)
for fr in inp.decode(inp.streams.audio[0]):
    for f in rs.resample(fr):
        for p in oa.encode(f):
            out.mux(p)
for p in oa.encode(None):
    out.mux(p)
out.close()
