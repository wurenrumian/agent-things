下面是lidang的一个post

> 我从2025年就一直反复强调。  
>
> 现在所有大学本科生最重要的第一节课，就是买一个最大的coding plan，用上claude code或者codex，  
>
> 第二节课是自己做一个最最最小版本的coding agent，可以对比codex或者claode code的基本功能，只要能输入一个基本功能，iteratively让agent完成写代码、编译、测试、 运行的功能即可，一切在terminal里，先把terminal和tool calling功能做好，  
>
> 第三节课是认真观察codex和claude code的基本功能，把里面的memory、skills、multi agent/subagent、background tasks、session管理、context compression、TUI/GUI设计、如何可视化diff、如何管理好额外的btw等等类似的功能、如何把goal的功能放进去、如何实现scheduled tasks、如何实现权限管理等等，一步步一点点摸索实现出来。  
>
> 我反复讲，一个计算机本科生能看完立党AI研究学习教程，把上面这三节课做完，就已经吊打清华计算机80%以上的本科生了。

我大概了解这些功能的实现是怎么样的，也知道这些东西的本质其实就是上下文管理，所谓tools还有什么其他一些功能其实就是写在上下文引导里的，不过我对里面一些功能具体实现的方式还不是特别了解，比如说mcp和skill之类的，skill是怎么做到获取skill是不会影响kv cache的，比如说mcp的上下文管理机制是什么，这些具体的机制我其实还不是特别懂。所以有动机去开启这个项目。所以这个项目的目的就是去带着做一个agent，去了解里面一些功能的机制。

lidang的post的功能其实还是有所缺失的，所以需要后续补充，也许可以通过grillme skill来确定需求，然后开启这个项目。