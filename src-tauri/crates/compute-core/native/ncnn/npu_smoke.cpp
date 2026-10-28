#include <cstdio>
#include <vector>
#include <chrono>
#include <cmath>
#include <fstream>
extern "C" {void* yomika_litert_open(const char*,const char*,const char*,int,bool);int yomika_litert_run(void*,const float*,float*);void yomika_litert_close(void*);const char* yomika_litert_error();}
int main(int argc,char**argv){
 if(argc!=4)return 2;
 auto start=std::chrono::steady_clock::now();
 auto s=yomika_litert_open(argv[1],argv[2],argv[3],2,false);
 if(!s){printf("open failed: %s\n",yomika_litert_error());return 1;}
 printf("compile %.3fs\n",std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count());fflush(stdout);
 std::vector<float> input(256*256*3),out(512*512*3);
 for(int i=0;i<(int)input.size();++i)input[i]=float((i*7)%251)/255.f;
 for(int k=0;k<3;++k){auto t=std::chrono::steady_clock::now();if(yomika_litert_run(s,input.data(),out.data())){printf("run failed: %s\n",yomika_litert_error());return 1;}printf("run %d %.3fs\n",k,std::chrono::duration<double>(std::chrono::steady_clock::now()-t).count());fflush(stdout);}
 std::ofstream f("npu-output.raw", std::ios::binary); f.write(reinterpret_cast<char*>(out.data()),out.size()*sizeof(float));
 yomika_litert_close(s); puts("fully delegated NPU completed; session destroyed");
}
