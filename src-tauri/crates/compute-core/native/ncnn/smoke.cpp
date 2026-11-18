#include <cstdio>
#include <cstdlib>
#include <vector>
#include <fstream>
#include <chrono>
extern "C" {const char* yomika_ncnn_device();const char* yomika_ncnn_error();void* yomika_ncnn_open(const char*,const unsigned char*);int yomika_ncnn_run(void*,const float*,float*,int,int,int);void yomika_ncnn_close(void*);}
int main(int argc,char** argv) {
 if(argc!=5 && argc!=7)return 2;
 const bool whole_frame = argc == 7;
 const int width = whole_frame ? std::atoi(argv[5]) : 128;
 const int height = whole_frame ? std::atoi(argv[6]) : 128;
 if (width < 20 || height < 20 || width > 4096 || height > 4096) return 2;
 std::ifstream p(argv[1]);std::string param((std::istreambuf_iterator<char>(p)),{});
 std::ifstream b(argv[2],std::ios::binary);std::vector<unsigned char> weights((std::istreambuf_iterator<char>(b)),{});
 printf("device=%s\n",yomika_ncnn_device());fflush(stdout);
 auto start=std::chrono::steady_clock::now();void* s=yomika_ncnn_open(param.c_str(),weights.data());
 if(!s){printf("open: %s\n",yomika_ncnn_error());return 1;}
 std::vector<float> in(3*width*height),out(12*width*height);std::ifstream f(argv[3],std::ios::binary);f.read((char*)in.data(),in.size()*4); if (!f) return 2;
 for(int i=0;i<3;++i){auto t=std::chrono::steady_clock::now();if(yomika_ncnn_run(s,in.data(),out.data(),width,height,whole_frame)){printf("run: %s\n",yomika_ncnn_error());return 1;}printf("run%d=%.3fs\n",i,std::chrono::duration<double>(std::chrono::steady_clock::now()-t).count());fflush(stdout);}
 std::ofstream o(argv[4],std::ios::binary);o.write((char*)out.data(),out.size()*4);yomika_ncnn_close(s);
 printf("total=%.3fs\n",std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count());
}
